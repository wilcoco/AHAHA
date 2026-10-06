import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from './llm.js';
import { json, readJson } from './chat.js';

type Query=(sql:string,params?:any[])=>Promise<{rows:any[];rowCount:number|null}>;
export async function initSupportDb(q:Query){
  await q(`CREATE TABLE IF NOT EXISTS point_wallets(user_id uuid PRIMARY KEY REFERENCES users(id),balance bigint NOT NULL DEFAULT 1000 CHECK(balance>=0));
    CREATE TABLE IF NOT EXISTS support_events(id uuid PRIMARY KEY,request_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),
      exploration_id uuid NOT NULL REFERENCES explorations(id),amount bigint NOT NULL CHECK(amount>0),percentage integer NOT NULL,
      result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,request_id));
    CREATE TABLE IF NOT EXISTS support_positions(user_id uuid NOT NULL REFERENCES users(id),exploration_id uuid NOT NULL REFERENCES explorations(id),
      points bigint NOT NULL CHECK(points>0),PRIMARY KEY(user_id,exploration_id));
    CREATE TABLE IF NOT EXISTS point_ledger(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),event_id uuid REFERENCES support_events(id),
      amount bigint NOT NULL,kind text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS point_ledger_owner_idx ON point_ledger(user_id,created_at DESC);`);
}
async function ensureWallet(q:Query,id:string){
  // The one-time allocation and its ledger entry are atomic, including on GET.
  await q(`WITH added AS (INSERT INTO point_wallets(user_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING user_id)
    INSERT INTO point_ledger(id,user_id,amount,kind) SELECT $2,user_id,1000,'welcome' FROM added`,[id,randomUUID()]);
}
export function createSupport(pool:pg.Pool){
  const q:Query=(sql,params)=>pool.query(sql,params);
  async function wallet(userId:string){
    await ensureWallet(q,userId);
    const row=(await q(`SELECT w.balance,COALESCE((SELECT SUM(amount) FROM point_ledger WHERE user_id=$1 AND kind IN ('author_reward','early_reward')),0) AS earned,
      COALESCE((SELECT SUM(points) FROM support_positions WHERE user_id=$1),0) AS supported FROM point_wallets w WHERE w.user_id=$1`,[userId])).rows[0];
    return {balance:Number(row.balance),earned:Number(row.earned),supported:Number(row.supported)};
  }
  async function summary(id:string,userId:string|null){
    const e=(await q("SELECT user_id,status FROM explorations WHERE id=$1 AND (status='published' OR user_id=$2)",[id,userId])).rows[0];
    if(!e)throw new AppError(404,'not_found','글을 찾을 수 없습니다.');
    const s=(await q('SELECT COALESCE(SUM(points),0) AS total,COUNT(*) AS supporters FROM support_positions WHERE exploration_id=$1',[id])).rows[0];
    const mine=userId?(await q(`SELECT COALESCE((SELECT points FROM support_positions WHERE exploration_id=$1 AND user_id=$2),0) AS points,
      COALESCE((SELECT SUM(l.amount) FROM point_ledger l JOIN support_events e ON e.id=l.event_id WHERE e.exploration_id=$1 AND l.user_id=$2 AND l.kind='early_reward'),0) AS rewards`,[id,userId])).rows[0]:null;
    const eligible=(await q('SELECT COUNT(*) AS n FROM support_positions WHERE exploration_id=$1 AND user_id IS DISTINCT FROM $2',[id,userId])).rows[0];
    return {total:Number(s.total),supporters:Number(s.supporters),mine:mine?{points:Number(mine.points),rewards:Number(mine.rewards)}:null,
      can_support:!!userId&&e.status==='published'&&e.user_id!==userId,
      has_prior_supporters:Number(eligible.n)>0,author_share:70,early_share:30,wallet:userId?await wallet(userId):null};
  }
  async function invest(userId:string,id:string,data:Record<string,unknown>){
    if(typeof data.request_id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data.request_id)||!Number.isInteger(data.percentage)||Number(data.percentage)<1||Number(data.percentage)>100||!Number.isSafeInteger(data.expected_balance)||Number(data.expected_balance)<0)throw new AppError(400,'invalid_support','포인트와 지지 비율을 확인하세요.');
    const client=await pool.connect();const cq:Query=(sql,p)=>client.query(sql,p);
    try{
      await client.query('BEGIN');
      // A short global ledger lock makes allocation order deterministic and prevents wallet deadlocks.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('exploration-point-ledger'))");
      const previous=(await cq('SELECT exploration_id,result FROM support_events WHERE user_id=$1 AND request_id=$2',[userId,data.request_id])).rows[0];
      if(previous){if(previous.exploration_id!==id)throw new AppError(409,'request_reused','새 요청으로 다시 시도하세요.');await client.query('COMMIT');return previous.result;}
      const e=(await cq("SELECT user_id FROM explorations WHERE id=$1 AND status='published' FOR SHARE",[id])).rows[0];
      if(!e)throw new AppError(404,'not_published','공개된 글에만 포인트로 지지할 수 있습니다.');
      if(e.user_id===userId)throw new AppError(400,'self_support','자신의 글에는 투자할 수 없습니다.');
      await ensureWallet(cq,userId);
      const w=(await cq('SELECT balance FROM point_wallets WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
      const balance=BigInt(w.balance);
      if(balance!==BigInt(Number(data.expected_balance)))throw new AppError(409,'balance_changed','포인트 잔액이 바뀌었습니다. 최신 잔액을 확인하고 다시 선택하세요.');
      const amount=balance*BigInt(Number(data.percentage))/100n;
      if(amount<1n)throw new AppError(400,'insufficient_points','선택한 비율로 투자할 포인트가 부족합니다.');
      const positions=(await cq('SELECT user_id,points FROM support_positions WHERE exploration_id=$1 AND user_id<>$2 ORDER BY user_id',[id,userId])).rows;
      const total=positions.reduce((n:bigint,p:any)=>n+BigInt(p.points),0n);
      const poolAmount=amount*30n/100n;
      const allocations=positions.map(p=>({user_id:p.user_id,amount:total?poolAmount*BigInt(p.points)/total:0n})).filter(p=>p.amount>0n);
      const earlyTotal=allocations.reduce((n,p)=>n+p.amount,0n);const authorAmount=amount-earlyTotal;
      const eventId=randomUUID();
      const result={id:eventId,amount:Number(amount),author_received:Number(authorAmount),prior_supporters_received:Number(earlyTotal),balance:Number(balance-amount),percentage:data.percentage};
      await cq('INSERT INTO support_events(id,request_id,user_id,exploration_id,amount,percentage,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[eventId,data.request_id,userId,id,amount.toString(),data.percentage,JSON.stringify(result)]);
      await cq('UPDATE point_wallets SET balance=balance-$2 WHERE user_id=$1',[userId,amount.toString()]);
      await cq("INSERT INTO point_ledger(id,user_id,event_id,amount,kind) VALUES($1,$2,$3,$4,'support_sent')",[randomUUID(),userId,eventId,(-amount).toString()]);
      const recipients=[{user_id:e.user_id,amount:authorAmount,kind:'author_reward'},...allocations.map(a=>({...a,kind:'early_reward'}))];
      for(const r of recipients){
        await ensureWallet(cq,r.user_id);
        await cq('UPDATE point_wallets SET balance=balance+$2 WHERE user_id=$1',[r.user_id,r.amount.toString()]);
        await cq('INSERT INTO point_ledger(id,user_id,event_id,amount,kind) VALUES($1,$2,$3,$4,$5)',[randomUUID(),r.user_id,eventId,r.amount.toString(),r.kind]);
      }
      await cq(`INSERT INTO support_positions(user_id,exploration_id,points) VALUES($1,$2,$3)
        ON CONFLICT(user_id,exploration_id) DO UPDATE SET points=support_positions.points+EXCLUDED.points`,[userId,id,amount.toString()]);
      await client.query('COMMIT');return result;
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async function api(req:IncomingMessage,res:ServerResponse,path:string,userId:string|null){
    if(path==='/api/support/wallet'&&req.method==='GET'){
      if(!userId)throw new AppError(401,'sign_in_required','로그인이 필요합니다.');json(res,200,await wallet(userId));return;
    }
    const m=path.match(/^\/api\/explorations\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/support$/i);
    if(!m)throw new AppError(404,'not_found','경로를 찾을 수 없습니다.');
    if(req.method==='GET'){json(res,200,await summary(m[1],userId));return;}
    if(req.method==='POST'&&userId){json(res,200,await invest(userId,m[1],await readJson(req,1024)));return;}
    throw new AppError(401,'sign_in_required','로그인이 필요합니다.');
  }
  return {api,wallet,summary,invest};
}
