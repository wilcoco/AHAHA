import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import pg from 'pg';
import {createAccount,initAccountDb,safeNext} from '../src/account.js';
test('login return paths cannot escape the application',()=>{
 for(const path of ['//evil.invalid','/\\evil.invalid','/\r\nevil','https://evil.invalid','/auth/google','/login'])assert.equal(safeNext(path),'/chat');
 assert.equal(safeNext('/chat?exploration=123'),'/chat?exploration=123');
});
test('Google login binds one-time state to browser and keeps identity separate from existing names',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 const schema='auth_'+crypto.randomBytes(12).toString('hex');await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options','-c search_path='+schema);
 const pool=new pg.Pool({connectionString:url.toString()});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,username text UNIQUE,display_name text,token_hash text,password_hash text)`);await initAccountDb(pool);await initAccountDb(pool);
 let exchangeCount=0,verifiedNonce='',rejectToken=false;const sessions:string[]=[];
 const account=createAccount({pool,shell:(_t,b)=>b,body:async()=>'',cookies:req=>Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(v=>v.trim().split('='))),session:async id=>{sessions.push(id);return 'synthetic-session';},user:async()=>null,credentials:async()=>null,password:()=>({salt:'',digest:''}),webCookie:raw=>'exploration_web='+raw,
 env:{GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'synthetic-test-secret'},
 fetchImpl:(async(_url,opts)=>{exchangeCount++;assert.equal(new URLSearchParams(String(opts?.body)).get('code_verifier')?.length,43);return Response.json({id_token:'synthetic-token'});}) as typeof fetch,
 verifyGoogle:async(_token,nonce)=>{verifiedNonce=nonce;if(rejectToken)throw new Error('invalid-signature');return {sub:'google-unique-id',name:'Existing name'};}});
 let origin='';const server=http.createServer(async(req,res)=>{try{await account.handle(req,res,new URL(req.url!,origin),origin);}catch{res.statusCode=500;res.end();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+(server.address() as any).port;
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 async function start(){const r=await fetch(origin+'/auth/google?next=/blog',{redirect:'manual'});assert.equal(r.status,303);const dest=new URL(r.headers.get('location')!);assert.equal(dest.hostname,'accounts.google.com');assert.equal(dest.searchParams.get('code_challenge_method'),'S256');return {state:dest.searchParams.get('state')!,nonce:dest.searchParams.get('nonce')!,cookie:r.headers.get('set-cookie')!.split(';')[0]};}
 const first=await start();const path='/auth/google/callback?code=synthetic-code&state='+first.state;
 assert.equal((await fetch(origin+path,{redirect:'manual'})).status,400);assert.equal(exchangeCount,0);
 const valid=await fetch(origin+path,{headers:{cookie:first.cookie},redirect:'manual'});assert.equal(valid.status,303);assert.equal(valid.headers.get('location'),'/blog');assert.equal(verifiedNonce,first.nonce);assert.equal(sessions.length,1);
 assert.equal((await fetch(origin+path,{headers:{cookie:first.cookie},redirect:'manual'})).status,400);
 const second=await start();assert.equal((await fetch(origin+'/auth/google/callback?code=x&state='+second.state,{headers:{cookie:second.cookie},redirect:'manual'})).status,303);assert.equal(sessions[0],sessions[1]);
 assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count,'1');
 const expired=await start();await pool.query("UPDATE google_login_states SET expires_at=now()-interval '1 minute'");assert.equal((await fetch(origin+'/auth/google/callback?code=x&state='+expired.state,{headers:{cookie:expired.cookie},redirect:'manual'})).status,400);
 rejectToken=true;const bad=await start();assert.equal((await fetch(origin+'/auth/google/callback?code=x&state='+bad.state,{headers:{cookie:bad.cookie},redirect:'manual'})).status,502);assert.equal(sessions.length,2);
});
