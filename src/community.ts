import type { IncomingMessage,ServerResponse } from 'node:http';
import {AppError} from './llm.js';
import {json,readJson} from './chat.js';
type Query=(sql:string,params?:any[])=>Promise<{rows:any[];rowCount:number|null}>;
export async function initCommunity(q:Query){
 await q(`CREATE TABLE IF NOT EXISTS exploration_readers(exploration_id uuid REFERENCES explorations(id) ON DELETE CASCADE,user_id uuid REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(exploration_id,user_id));
 CREATE TABLE IF NOT EXISTS creator_follows(follower_id uuid REFERENCES users(id) ON DELETE CASCADE,author_id uuid REFERENCES users(id) ON DELETE CASCADE,created_at timestamptz DEFAULT now(),PRIMARY KEY(follower_id,author_id),CHECK(follower_id<>author_id));
 CREATE TABLE IF NOT EXISTS reader_bookmarks(user_id uuid REFERENCES users(id) ON DELETE CASCADE,exploration_id uuid REFERENCES explorations(id) ON DELETE CASCADE,created_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,exploration_id));
 CREATE TABLE IF NOT EXISTS reader_notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES users(id) ON DELETE CASCADE,exploration_id uuid REFERENCES explorations(id) ON DELETE CASCADE,kind text NOT NULL,read_at timestamptz,created_at timestamptz DEFAULT now(),UNIQUE(user_id,exploration_id,kind));`);
}
export async function communityApi(q:Query,req:IncomingMessage,res:ServerResponse,url:URL,userId:string){
 const path=url.pathname;
 if(path==='/api/community/notifications'&&req.method==='GET'){
  const rows=(await q(`SELECT n.id,n.kind,n.read_at,n.created_at,e.id AS exploration_id,e.title,u.username FROM reader_notifications n JOIN explorations e ON e.id=n.exploration_id JOIN users u ON u.id=e.user_id WHERE n.user_id=$1 AND (e.status='published' OR e.user_id=$1 OR EXISTS(SELECT 1 FROM exploration_readers r WHERE r.exploration_id=e.id AND r.user_id=$1)) ORDER BY n.created_at DESC LIMIT 100`,[userId])).rows;
  json(res,200,{notifications:rows});return;
 }
 if(path==='/api/community/notifications/read'&&req.method==='POST'){
  const data=await readJson(req,2000);if(typeof data.id!=='string'||!/^[a-f0-9-]{36}$/i.test(data.id))throw new AppError(400,'invalid_notification','알림을 선택하세요.');
  await q('UPDATE reader_notifications SET read_at=now() WHERE id=$1 AND user_id=$2',[data.id,userId]);json(res,200,{ok:true});return;
 }
 const match=path.match(/^\/api\/community\/(follow|bookmark)\/([^/]+)$/);
 if(!match)throw new AppError(404,'not_found','항목이 없습니다.');
 const kind=match[1];let id:string;
 if(kind==='follow'){
  const author=(await q('SELECT id FROM users WHERE username=$1',[decodeURIComponent(match[2])])).rows[0];
  if(!author||author.id===userId)throw new AppError(400,'invalid_author','다른 작성자를 구독할 수 있습니다.');id=author.id;
 }else{
  if(!/^[a-f0-9-]{36}$/i.test(match[2]))throw new AppError(404,'not_found','글을 찾을 수 없습니다.');
  const e=(await q("SELECT id FROM explorations WHERE id=$1 AND (status='published' OR user_id=$2 OR EXISTS(SELECT 1 FROM exploration_readers r WHERE r.exploration_id=explorations.id AND r.user_id=$2))",[match[2],userId])).rows[0];if(!e)throw new AppError(404,'not_found','글을 찾을 수 없습니다.');id=e.id;
 }
 const table=kind==='follow'?'creator_follows':'reader_bookmarks',owner=kind==='follow'?'follower_id':'user_id',target=kind==='follow'?'author_id':'exploration_id';
 if(req.method==='PUT')await q(`INSERT INTO ${table}(${owner},${target}) VALUES($1,$2) ON CONFLICT DO NOTHING`,[userId,id]);
 else if(req.method==='DELETE')await q(`DELETE FROM ${table} WHERE ${owner}=$1 AND ${target}=$2`,[userId,id]);
 else if(req.method!=='GET')throw new AppError(405,'method_not_allowed','지원하지 않는 요청입니다.');
 const active=!!(await q(`SELECT 1 FROM ${table} WHERE ${owner}=$1 AND ${target}=$2`,[userId,id])).rowCount;json(res,200,{active});
}
