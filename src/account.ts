import crypto from 'node:crypto';
import type http from 'node:http';
import type pg from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';
const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function safeNext(s:string|null){return s && /^\/(?!\/)/.test(s) && !/[\\\r\n]/.test(s) && !s.startsWith('/auth/') && !s.startsWith('/login') && !s.startsWith('/register') ? s : '/chat';}
export async function initAccountDb(pool:pg.Pool){await pool.query(`
 ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_hash text;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text UNIQUE;
 CREATE TABLE IF NOT EXISTS account_attempts(key text PRIMARY KEY,count int NOT NULL,until timestamptz NOT NULL);
 CREATE TABLE IF NOT EXISTS google_login_states(state_hash text PRIMARY KEY,browser_hash text NOT NULL,nonce text NOT NULL,verifier text NOT NULL,next_path text NOT NULL,expires_at timestamptz NOT NULL);
`);}
export function createAccount(deps:{pool:pg.Pool;shell:(title:string,body:string,me?:boolean)=>string;body:(req:http.IncomingMessage)=>Promise<string>;cookies:(req:http.IncomingMessage)=>Record<string,string>;session:(id:string)=>Promise<string>;user:(raw:string)=>Promise<any>;credentials:(name:string,password:string)=>Promise<any>;password:(raw:string)=>{salt:string,digest:string};webCookie:(s:string)=>string;env?:NodeJS.ProcessEnv;fetchImpl?:typeof fetch;verifyGoogle?:(token:string,nonce:string)=>Promise<{sub:string,name?:string}>}){
 const {pool,shell,body,cookies,session,user,credentials,password,webCookie}=deps,env=deps.env||process.env,fetcher=deps.fetchImpl||fetch;
 const q=(sql:string,p:any[]=[])=>pool.query(sql,p);
 const google=()=>!!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
 const jwks=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
 const field=(label:string,name:string,type='text',extra='')=>`<label>${label}<input name="${name}" type="${type}" required ${extra} style="display:block;width:100%;box-sizing:border-box"></label>`;
 const pw=(label='비밀번호',name='password',fresh=false)=>field(label,name,'password',`minlength="8" maxlength="256" autocomplete="${fresh?'new-password':'current-password'}"`);
 const message=(s:string)=>s?`<p role="status">${esc(s)}</p>`:'';
 function auth(error='',next='/chat',register=false){return shell(register?'회원가입':'로그인',`<section class="profile"><h1>${register?'함께 쓰기 시작하세요':'다시 만나 반갑습니다'}</h1><p>AI와 나눈 대화를 나의 콘텐츠로 남기세요.</p></section><section class="panel" style="max-width:480px;margin:24px auto">${message(error)}${google()?`<p><a class="btn" style="display:block;text-align:center" href="/auth/google?next=${encodeURIComponent(safeNext(next))}">Google로 계속하기</a></p><p>또는 아이디로 ${register?'가입':'로그인'}</p>`:''}<form class="form" method="post" action="/${register?'register':'login'}"><input type="hidden" name="next" value="${esc(safeNext(next))}">${field('아이디','username','text','autocomplete="username" minlength="3" maxlength="32" pattern="[a-zA-Z0-9_-]{3,32}" autocapitalize="none" spellcheck="false"')}${register?'<small>영문·숫자·밑줄·하이픈 3~32자. 내 블로그 주소에 사용합니다.</small>'+field('표시 이름','display_name','text','maxlength="80" autocomplete="nickname"'):''}${pw('비밀번호','password',register)}${register?pw('비밀번호 확인','password_confirm',true)+'<small>8~256자. 가입 후 설정에서 계정 복구 코드를 보관해 주세요.</small>':''}<button class="btn">${register?'회원가입':'로그인'}</button></form><p><a href="/${register?'login':'register'}?next=${encodeURIComponent(safeNext(next))}">${register?'이미 계정이 있나요? 로그인':'처음인가요? 회원가입'}</a></p>${register?'':'<p><a href="/account/recover">비밀번호를 잊으셨나요?</a></p>'}</section>`);}
 function recovery(error=''){return shell('계정 복구',`<section class="profile"><h1>계정 복구</h1><p>설정에서 미리 발급한 복구 코드로 비밀번호를 재설정합니다.</p></section><section class="panel">${message(error)}<form method="post" action="/account/recover" class="form">${field('아이디','username','text','autocomplete="username" maxlength="32"')}${field('복구 코드','recovery_code','password','autocomplete="off" maxlength="100"')}${pw('새 비밀번호','password',true)}${pw('새 비밀번호 확인','password_confirm',true)}<button class="btn">비밀번호 재설정</button></form><p>코드는 한 번만 사용할 수 있습니다. 재설정하면 모든 기기에서 로그아웃되고 AI 연결도 해제됩니다.</p><p>복구 코드를 보관하지 않았다면 이 방법으로 복구할 수 없습니다. Google로 가입한 계정은 Google 로그인을 이용하세요. 이메일 복구는 아직 지원하지 않습니다.</p><a href="/login">로그인으로 돌아가기</a></section>`);}
 async function accountPage(u:any,note=''){const r=(await q('SELECT recovery_hash,password_hash,google_sub FROM users WHERE id=$1',[u.id])).rows[0];return shell('계정 관리',`<section class="profile"><h1>계정 관리</h1><p>${esc(u.display_name)} · @${esc(u.username)}</p></section>${message(note)}<section class="panel"><h2>로그인 및 보안</h2><p>${r.google_sub?'Google 로그인 계정':'아이디·비밀번호 계정'}</p>${r.password_hash?`<h3>비밀번호 변경</h3><p>변경하면 모든 기기에서 로그아웃되고 AI 연결과 기존 복구 코드가 해제됩니다. 다시 로그인한 후 복구 코드를 새로 발급하세요.</p><form class="form" method="post" action="/account/password">${pw('현재 비밀번호','current_password')}${pw('새 비밀번호','password',true)}${pw('새 비밀번호 확인','password_confirm',true)}<button class="btn">비밀번호 변경 · 모든 기기 로그아웃</button></form><h3>계정 복구 코드</h3><p>${r.recovery_hash?'복구 코드가 발급되어 있습니다.':'아직 복구 코드가 없습니다.'} 비밀번호를 잊기 전에 발급해 안전한 곳에 보관하세요. 새 코드를 발급하면 이전 코드는 사용할 수 없습니다.</p><form class="form" method="post" action="/account/recovery-code">${pw('현재 비밀번호','current_password')}<button class="btn">복구 코드 새로 발급</button></form>`:'<p>비밀번호와 복구 수단은 Google 계정에서 관리합니다. 기존 아이디 계정과 자동으로 합쳐지지 않습니다.</p>'}</section><section class="panel"><h2>로그아웃</h2><form method="post" action="/logout"><button class="btn">이 기기에서 로그아웃</button></form><p>글과 대화는 그대로 보관됩니다.</p><a href="/me">설정으로 돌아가기</a></section>`,true);}
 async function limited(key:string,max=15){const r=await q(`INSERT INTO account_attempts(key,count,until) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN account_attempts.until<now() THEN 1 ELSE account_attempts.count+1 END,until=CASE WHEN account_attempts.until<now() THEN now()+interval '15 minutes' ELSE account_attempts.until END RETURNING count`,[hash(key)]);return r.rows[0].count>max;}
 const clearCookies=()=>['exploration_web','exploration_session'].map(n=>`${n}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${env.NODE_ENV==='production'?'; Secure':''}`);
 async function invalidate(client:pg.PoolClient,id:string){await client.query('DELETE FROM web_sessions WHERE user_id=$1',[id]);await client.query('UPDATE oauth_tokens SET revoked_at=now() WHERE user_id=$1',[id]);await client.query('DELETE FROM oauth_codes WHERE user_id=$1',[id]);await client.query('UPDATE users SET token_hash=$2 WHERE id=$1',[id,hash(crypto.randomBytes(32).toString('hex'))]);}
 async function handle(req:http.IncomingMessage,res:http.ServerResponse,url:URL,origin:string){
  const path=url.pathname,post=req.method==='POST';
  if(!['/login','/register','/logout','/account','/account/password','/account/recover','/account/recovery-code','/auth/google','/auth/google/callback'].includes(path))return false;
  const send=(status:number,markup:string)=>{res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'same-origin','x-frame-options':'DENY'});res.end(markup);return true;};
  const go=(path:string,cs?:string|string[])=>{res.writeHead(303,{location:path,'cache-control':'no-store',...(cs?{'set-cookie':cs}:{})});res.end();return true;};
  if(post&&(req.headers.origin!==new URL(origin).origin||req.headers['sec-fetch-site']==='cross-site'))return send(403,auth('요청을 확인할 수 없습니다. 이 화면에서 다시 시도해 주세요.'));
  if(!post&&req.method!=='GET')return send(405,auth('지원하지 않는 요청입니다.'));
  const c=cookies(req),u=await user(c.exploration_web||'');
  if((path==='/login'||path==='/register')&&!post){if(u)return go(safeNext(url.searchParams.get('next')));return send(200,auth(url.searchParams.has('reset')?'비밀번호가 변경되었습니다. 새 비밀번호로 로그인해 주세요.':'',safeNext(url.searchParams.get('next')),path==='/register'));}
  if(path==='/account/recover'&&!post)return send(200,recovery());
  if(path==='/logout'&&post){if(c.exploration_web)await q('DELETE FROM web_sessions WHERE session_hash=$1',[hash(c.exploration_web)]);return go('/login',clearCookies());}
  if(path==='/account'&&!post){if(!u)return go('/login?next=/account');return send(200,await accountPage(u));}
  if(path==='/auth/google'&&!post){
   if(!google())return send(503,auth('Google 로그인은 아직 준비 중입니다. 아이디로 로그인해 주세요.'));
   const state=crypto.randomBytes(32).toString('base64url'),browser=crypto.randomBytes(32).toString('base64url'),nonce=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(32).toString('base64url');
   if(await limited('google:'+req.socket.remoteAddress,100))return send(429,auth('잠시 후 다시 시도해 주세요.'));
   await q('DELETE FROM google_login_states WHERE expires_at<now()');await q(`INSERT INTO google_login_states VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')`,[hash(state),hash(browser),nonce,verifier,safeNext(url.searchParams.get('next'))]);
   const dest=new URL('https://accounts.google.com/o/oauth2/v2/auth');dest.search=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID!,redirect_uri:origin+'/auth/google/callback',response_type:'code',scope:'openid profile',state,nonce,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'select_account'}).toString();
   return go(dest.toString(),`exploration_google=${browser}; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=600${env.NODE_ENV==='production'?'; Secure':''}`);
  }
  if(path==='/auth/google/callback'&&!post){
   res.setHeader('set-cookie',`exploration_google=; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=0${env.NODE_ENV==='production'?'; Secure':''}`);
   const state=(await q('DELETE FROM google_login_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *',[hash(url.searchParams.get('state')||''),hash(c.exploration_google||'')])).rows[0];
   if(!google()||!state||url.searchParams.has('error')||!url.searchParams.get('code'))return send(400,auth('Google 로그인이 취소되었거나 만료되었습니다. 다시 시작해 주세요.'));
   try{
    const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID!,client_secret:env.GOOGLE_CLIENT_SECRET!,code:url.searchParams.get('code')!,code_verifier:state.verifier,redirect_uri:origin+'/auth/google/callback',grant_type:'authorization_code'}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('provider');const tokens=await response.json() as any;
    let identity:{sub:string,name?:string};
    if(deps.verifyGoogle)identity=await deps.verifyGoogle(tokens.id_token,state.nonce);
    else{const {payload}=await jwtVerify(tokens.id_token,jwks,{issuer:['https://accounts.google.com','accounts.google.com'],audience:env.GOOGLE_CLIENT_ID,algorithms:['RS256'],requiredClaims:['exp','iat','sub','nonce']});if(payload.nonce!==state.nonce||typeof payload.sub!=='string')throw new Error('identity');identity={sub:payload.sub,name:typeof payload.name==='string'?payload.name:undefined};}
    if(!identity.sub)throw new Error('identity');
    const uid=crypto.randomUUID();const row=(await q(`INSERT INTO users(id,username,display_name,token_hash,google_sub) VALUES($1,$2,$3,$4,$5) ON CONFLICT(google_sub) DO UPDATE SET google_sub=EXCLUDED.google_sub RETURNING id`,[uid,'writer_'+crypto.randomBytes(10).toString('hex'),(identity.name||'새 작가').slice(0,80),hash(crypto.randomBytes(32).toString('hex')),identity.sub])).rows[0];
    return go(state.next_path,[webCookie(await session(row.id)),String(res.getHeader('set-cookie'))]);
   }catch{return send(502,auth('Google 로그인을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'));}
  }
  if(!post)return send(405,auth('이 작업은 계정 관리 화면에서 진행해 주세요.'));
  const p=new URLSearchParams(await body(req)),name=String(p.get('username')||'').trim().toLowerCase(),next=safeNext(p.get('next')),raw=p.get('password')||'';
  if(await limited('account:'+(u?.id||name||req.socket.remoteAddress))||await limited('address:'+req.socket.remoteAddress,300)){res.setHeader('retry-after','900');return send(429,auth('시도가 너무 많습니다. 15분 후 다시 시도해 주세요.'));}
  const validPassword=raw.length>=8&&raw.length<=256&&raw===p.get('password_confirm');
  if(path==='/login'){const found=raw.length<=256?await credentials(name,raw):null;if(!found)return send(401,auth('아이디 또는 비밀번호를 확인해 주세요.',next));return go(next,webCookie(await session(found.id)));}
  if(path==='/register'){
   if(!/^[a-z0-9_-]{3,32}$/.test(name)||!validPassword)return send(400,auth('아이디 형식과 비밀번호(8~256자), 비밀번호 확인을 확인해 주세요.',next,true));
   const pr=password(raw),uid=crypto.randomUUID();try{await q('INSERT INTO users(id,username,display_name,token_hash,password_salt,password_hash) VALUES($1,$2,$3,$4,$5,$6)',[uid,name,(p.get('display_name')||name).trim().slice(0,80)||name,hash(crypto.randomBytes(32).toString('hex')),pr.salt,pr.digest]);}catch(e:any){if(e.code==='23505')return send(409,auth('이미 사용 중인 아이디입니다.',next,true));throw e;}
   return go(next,webCookie(await session(uid)));
  }
  if(path==='/account/recover'){
   if(!validPassword)return send(400,recovery('새 비밀번호와 확인 값이 같아야 하며 8~256자여야 합니다.'));
   const client=await pool.connect();try{await client.query('BEGIN');const found=(await client.query('SELECT id FROM users WHERE username=$1 AND recovery_hash=$2 FOR UPDATE',[name,hash((p.get('recovery_code')||'').trim())])).rows[0];if(!found){await client.query('ROLLBACK');return send(400,recovery('아이디 또는 복구 코드를 확인해 주세요.'));}const pr=password(raw);await client.query('UPDATE users SET password_salt=$2,password_hash=$3,recovery_hash=NULL WHERE id=$1',[found.id,pr.salt,pr.digest]);await invalidate(client,found.id);await client.query('COMMIT');return go('/login?reset=1',clearCookies());}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  if(!u)return go('/login?next=/account');
  const current=p.get('current_password')||'';
  if(current.length>256||!await credentials(u.username,current))return send(401,await accountPage(u,'현재 비밀번호를 확인해 주세요.'));
  if(path==='/account/recovery-code'){const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[u.id]);if(!await credentials(u.username,current)){await client.query('ROLLBACK');return send(401,await accountPage(u,'현재 비밀번호를 확인해 주세요.'));}const code=crypto.randomBytes(24).toString('hex').match(/.{1,8}/g)!.join('-');await client.query('UPDATE users SET recovery_hash=$2 WHERE id=$1',[u.id,hash(code)]);await client.query('COMMIT');return send(200,shell('복구 코드 보관',`<section class="panel"><h1>복구 코드를 보관하세요</h1><p>이 화면에서만 확인할 수 있습니다. 비밀번호 관리자 등 안전한 곳에 아이디와 함께 보관하세요. 이전 코드는 무효화되었습니다.</p><code style="overflow-wrap:anywhere" id="recovery-code">${code}</code><p>이 코드를 가진 사람은 비밀번호를 재설정할 수 있습니다. 다른 사람에게 공유하지 마세요.</p><a href="/account">보관했습니다 · 계정 관리로</a></section>`,true));}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
  if(path==='/account/password'){if(!validPassword)return send(400,await accountPage(u,'새 비밀번호와 확인 값이 같아야 하며 8~256자여야 합니다.'));const client=await pool.connect();try{await client.query('BEGIN');const pr=password(raw);await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[u.id]);if(!await credentials(u.username,current)){await client.query('ROLLBACK');return send(401,await accountPage(u,'현재 비밀번호를 확인해 주세요.'));}await client.query('UPDATE users SET password_salt=$2,password_hash=$3,recovery_hash=NULL WHERE id=$1',[u.id,pr.salt,pr.digest]);await invalidate(client,u.id);await client.query('COMMIT');return go('/login?reset=1',clearCookies());}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
  return send(405,auth('지원하지 않는 요청입니다.'));
 }
 return {handle,auth};
}
