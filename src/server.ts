import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined
});

const q = (text: string, params: any[] = []) => pool.query(text, params);
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const token = () => "exp_" + crypto.randomBytes(24).toString("base64url");
const esc = (s: any) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]!));
const slugify = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9\u3131-\uD79D]+/g,"-").replace(/^-+|-+$/g,"").slice(0,64) || ("exploration-" + Date.now());

async function initDb() {
  await q(`
  CREATE TABLE IF NOT EXISTS users(
    id uuid PRIMARY KEY,
    username text UNIQUE NOT NULL,
    display_name text NOT NULL,
    bio text,
    token_hash text UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS explorations(
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug text NOT NULL,
    title text NOT NULL,
    opening_question text NOT NULL DEFAULT '',
    starting_view text NOT NULL DEFAULT '',
    key_turns jsonb NOT NULL DEFAULT '[]',
    turning_points jsonb NOT NULL DEFAULT '[]',
    current_view text NOT NULL DEFAULT '',
    source_platform text,
    source_model text,
    status text NOT NULL DEFAULT 'draft',
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, slug)
  );
  CREATE TABLE IF NOT EXISTS source_messages(
    id uuid PRIMARY KEY,
    exploration_id uuid NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
    position int NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    UNIQUE(exploration_id, position)
  );
  CREATE TABLE IF NOT EXISTS follows(
    follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(follower_id, followee_id)
  );
  ALTER TABLE users ADD COLUMN IF NOT EXISTS password_salt text;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
  CREATE TABLE IF NOT EXISTS web_sessions(
    session_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS oauth_clients(
    client_id text PRIMARY KEY,
    client_name text NOT NULL DEFAULT 'MCP Client',
    redirect_uris jsonb NOT NULL,
    client_secret_hash text,
    token_endpoint_auth_method text NOT NULL DEFAULT 'none',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS oauth_codes(
    code_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id text NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    scope text NOT NULL,
    resource text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens(
    access_token_hash text PRIMARY KEY,
    refresh_token_hash text UNIQUE NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id text NOT NULL,
    scope text NOT NULL,
    resource text NOT NULL,
    expires_at timestamptz NOT NULL,
    refresh_expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS oauth_tokens_refresh_idx ON oauth_tokens(refresh_token_hash);
  CREATE INDEX IF NOT EXISTS explorations_pub_idx ON explorations(status,published_at DESC);
  `);

  const found = await q("SELECT 1 FROM users WHERE username='explorer'");
  if (!found.rowCount) {
    const uid = crypto.randomUUID();
    await q("INSERT INTO users(id,username,display_name,bio,token_hash) VALUES($1,'explorer','Explorer','Demo creator showing the Exploration format.',$2)", [uid, hash(crypto.randomBytes(20).toString("hex"))]);
    const demos = [
      ["ai-dialogue-as-publishing","Can an AI dialogue become a new kind of blog?","If people increasingly think with AI, what becomes the publishable artifact?","I first assumed the conversation itself could simply be shared as content.",["Compared raw chat sharing with traditional blogging.","Looked at prompt libraries and conversation repositories."],["Raw AI conversations become repetitive quickly; the human context is what makes them worth reading."],"Publish the human question, judgment and change of mind first; keep the full AI conversation as source material."],
      ["mcp-as-ingestion-layer","Use MCP as the ingestion layer, not as the product","Can creators keep using their own AI without us paying inference costs?","I thought the service might need its own chat interface and LLM API.",["Separated model inference from publishing.","Mapped Remote MCP to storage and publishing tools."],["The model can remain replaceable while creator identity and published thinking stay persistent."],"Let the user keep their AI. Our product owns the publishing identity, continuity and social graph—not the model."],
      ["thought-git-history","A Git history for how a person changes their mind","What is more valuable than a chronological list of posts?","A creator page looked like enough: profile plus a list of conversations.",["Connected related explorations over time.","Distinguished editing a post from evolving a belief."],["A sequence of changing views can become a durable creator asset across AI providers."],"The long-term object is not a chat archive. It is a public history of how a person explores, revises and connects ideas."]
    ];
    for (const d of demos) {
      await q(`INSERT INTO explorations(id,user_id,slug,title,opening_question,starting_view,key_turns,turning_points,current_view,source_platform,source_model,status,published_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,'demo','none','published',now())`,
        [crypto.randomUUID(),uid,d[0],d[1],d[2],d[3],JSON.stringify(d[4]),JSON.stringify(d[5]),d[6]]);
    }
  }
}

function passwordRecord(password:string){
  const salt=crypto.randomBytes(16).toString("hex");
  return {salt,digest:crypto.scryptSync(password,salt,64).toString("hex")};
}
function verifyPassword(password:string,salt:string|null,digest:string|null){
  if(!salt||!digest)return false;
  const got=crypto.scryptSync(password,salt,64);
  const expected=Buffer.from(digest,"hex");
  return got.length===expected.length && crypto.timingSafeEqual(got,expected);
}
async function userByCredentials(username:string,password:string){
  const r=await q("SELECT id,username,display_name,bio,password_salt,password_hash FROM users WHERE username=$1 LIMIT 1",[username.toLowerCase()]);
  const u=r.rows[0]; if(!u||!verifyPassword(password,u.password_salt,u.password_hash))return null;
  return {id:u.id,username:u.username,display_name:u.display_name,bio:u.bio};
}
async function createWebSession(userId:string){
  const raw="web_"+crypto.randomBytes(32).toString("base64url");
  await q("INSERT INTO web_sessions(session_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[hash(raw),userId]);
  return raw;
}
async function userByWebSession(raw:string){
  if(!raw)return null;
  const r=await q(`SELECT u.id,u.username,u.display_name,u.bio FROM web_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.session_hash=$1 AND s.expires_at>now() LIMIT 1`,[hash(raw)]);
  return r.rows[0]||null;
}
async function userByToken(t: string, expectedResource?:string) {
  if (!t) return null;
  const legacy = await q("SELECT id,username,display_name,bio FROM users WHERE token_hash=$1 LIMIT 1",[hash(t)]);
  if(legacy.rows[0])return legacy.rows[0];
  const r=await q(`SELECT u.id,u.username,u.display_name,u.bio,o.resource FROM oauth_tokens o JOIN users u ON u.id=o.user_id
    WHERE o.access_token_hash=$1 AND o.expires_at>now() AND o.revoked_at IS NULL LIMIT 1`,[hash(t)]);
  const row=r.rows[0]; if(!row)return null;
  if(expectedResource && row.resource!==expectedResource)return null;
  return {id:row.id,username:row.username,display_name:row.display_name,bio:row.bio};
}
function oauthScope(raw:string|null){const allowed=new Set(["exploration.read","exploration.write"]);const requested=(raw||"exploration.read exploration.write").split(/\\s+/).filter(Boolean);return requested.filter(x=>allowed.has(x)).join(" ")||"exploration.read";}
function validRedirectUri(raw:string){
  try{const u=new URL(raw);if(u.protocol==="https:")return true;if(u.protocol==="http:"&&(u.hostname==="localhost"||u.hostname==="127.0.0.1"||u.hostname==="::1"))return true;return false;}catch{return false;}
}
function b64url(buf:Buffer){return buf.toString("base64url");}
function pkceS256(verifier:string){return b64url(crypto.createHash("sha256").update(verifier).digest());}
async function oauthClient(clientId:string){
  const r=await q("SELECT * FROM oauth_clients WHERE client_id=$1 LIMIT 1",[clientId]);return r.rows[0]||null;
}
async function currentWebUser(req:http.IncomingMessage){
  const c=cookies(req);const viaSession=await userByWebSession(c.exploration_web||"");if(viaSession)return viaSession;
  return userByToken(c.exploration_session||"");
}

async function createExploration(userId: string, a: any) {
  if (!a?.title) throw new Error("title is required");
  const id = crypto.randomUUID();
  let slug = slugify(a.title);
  const exists = await q("SELECT 1 FROM explorations WHERE user_id=$1 AND slug=$2",[userId,slug]);
  if (exists.rowCount) slug += "-" + crypto.randomBytes(3).toString("hex");

  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO explorations(id,user_id,slug,title,opening_question,starting_view,key_turns,turning_points,current_view,source_platform,source_model,status)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,'draft')`,
      [id,userId,slug,a.title,a.opening_question||"",a.starting_view||"",JSON.stringify(a.key_turns||[]),JSON.stringify(a.turning_points||[]),a.current_view||"",a.source_platform||null,a.source_model||null]);
    if (Array.isArray(a.source_messages)) {
      for (let i=0;i<a.source_messages.length;i++) {
        const m=a.source_messages[i];
        await client.query("INSERT INTO source_messages(id,exploration_id,position,role,content) VALUES($1,$2,$3,$4,$5)",[crypto.randomUUID(),id,i,m.role||"other",String(m.content||"")]);
      }
    }
    await client.query("COMMIT");
  } catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  return getMine(userId,id);
}

async function getMine(userId: string, idOrSlug: string) {
  const r = await q(`SELECT e.*,u.username,u.display_name FROM explorations e JOIN users u ON u.id=e.user_id
    WHERE e.user_id=$1 AND (e.id::text=$2 OR e.slug=$2) LIMIT 1`,[userId,idOrSlug]);
  return r.rows[0]||null;
}

async function listMine(userId: string) {
  const r = await q(`SELECT e.*,u.username,u.display_name FROM explorations e JOIN users u ON u.id=e.user_id
    WHERE e.user_id=$1 ORDER BY e.updated_at DESC LIMIT 50`,[userId]);
  return r.rows;
}

async function searchMine(userId: string, term: string) {
  const r = await q(`SELECT e.*,u.username,u.display_name FROM explorations e JOIN users u ON u.id=e.user_id
    WHERE e.user_id=$1 AND (e.title ILIKE $2 OR e.opening_question ILIKE $2 OR e.current_view ILIKE $2)
    ORDER BY e.updated_at DESC LIMIT 20`,[userId,"%"+term+"%"]);
  return r.rows;
}

async function searchPublic(term: string) {
  const r = await q(`SELECT e.*,u.username,u.display_name FROM explorations e JOIN users u ON u.id=e.user_id
    WHERE e.status='published' AND (e.title ILIKE $1 OR e.opening_question ILIKE $1 OR e.current_view ILIKE $1)
    ORDER BY e.published_at DESC LIMIT 20`,["%"+term+"%"]);
  return r.rows;
}

async function appendExploration(userId: string, a: any) {
  const item = await getMine(userId,a.id_or_slug);
  if (!item) throw new Error("exploration not found");
  const turns=[...(item.key_turns||[]),...(a.key_turns||[])];
  const points=[...(item.turning_points||[]),...(a.turning_points||[])];
  await q("UPDATE explorations SET key_turns=$1::jsonb,turning_points=$2::jsonb,current_view=COALESCE($3,current_view),updated_at=now() WHERE id=$4",
    [JSON.stringify(turns),JSON.stringify(points),a.current_view??null,item.id]);
  if (Array.isArray(a.source_messages) && a.source_messages.length) {
    const r=await q("SELECT COALESCE(MAX(position),-1)+1 n FROM source_messages WHERE exploration_id=$1",[item.id]);
    let p=Number(r.rows[0].n);
    for (const m of a.source_messages) {
      await q("INSERT INTO source_messages(id,exploration_id,position,role,content) VALUES($1,$2,$3,$4,$5)",
        [crypto.randomUUID(),item.id,p++,m.role||"other",String(m.content||"")]);
    }
  }
  return getMine(userId,item.id);
}

async function publishExploration(userId: string, a: any, origin: string) {
  const item = await getMine(userId,a.id_or_slug);
  if (!item) throw new Error("exploration not found");
  await q(`UPDATE explorations SET title=COALESCE($1,title),opening_question=COALESCE($2,opening_question),
    starting_view=COALESCE($3,starting_view),current_view=COALESCE($4,current_view),status='published',
    published_at=COALESCE(published_at,now()),updated_at=now() WHERE id=$5`,
    [a.title??null,a.opening_question??null,a.starting_view??null,a.current_view??null,item.id]);
  const now=await getMine(userId,item.id);
  return {...now,public_url: origin+"/@"+now.username+"/"+now.slug};
}

async function sourceMessages(explorationId:string) {
  return (await q("SELECT position,role,content FROM source_messages WHERE exploration_id=$1 ORDER BY position",[explorationId])).rows;
}

function toolDefs() {
  const msg = {type:"object",properties:{role:{type:"string"},content:{type:"string"}},required:["content"]};
  return [
    {name:"create_exploration",description:"Create a PRIVATE draft exploration from the current AI-assisted thinking. Capture the human question, starting view, key turns, turning points and current view. Do not publish automatically.",inputSchema:{type:"object",properties:{title:{type:"string"},opening_question:{type:"string"},starting_view:{type:"string"},key_turns:{type:"array",items:{type:"string"}},turning_points:{type:"array",items:{type:"string"}},current_view:{type:"string"},source_platform:{type:"string"},source_model:{type:"string"},source_messages:{type:"array",items:msg}},required:["title"]}},
    {name:"append_exploration",description:"Append new turns or a changed view to an existing private or published exploration.",inputSchema:{type:"object",properties:{id_or_slug:{type:"string"},key_turns:{type:"array",items:{type:"string"}},turning_points:{type:"array",items:{type:"string"}},current_view:{type:"string"},source_messages:{type:"array",items:msg}},required:["id_or_slug"]}},
    {name:"publish_exploration",description:"Make an exploration PUBLIC. Call only after the user explicitly asks to publish or share publicly.",inputSchema:{type:"object",properties:{id_or_slug:{type:"string"},title:{type:"string"},opening_question:{type:"string"},starting_view:{type:"string"},current_view:{type:"string"}},required:["id_or_slug"]}},
    {name:"get_exploration",description:"Get one of the authenticated creator's explorations and its optional source conversation.",inputSchema:{type:"object",properties:{id_or_slug:{type:"string"}},required:["id_or_slug"]}},
    {name:"list_my_explorations",description:"List the authenticated creator's recent drafts and published explorations.",inputSchema:{type:"object",properties:{}}},
    {name:"search_my_explorations",description:"Search the authenticated creator's own exploration history.",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]}},
    {name:"search_public_explorations",description:"Search public explorations from all creators.",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]}},
    {name:"get_creator_context",description:"Return a compact cross-AI history of how the creator has explored a topic over time.",inputSchema:{type:"object",properties:{query:{type:"string"}}}}
  ];
}

async function callTool(name:string,a:any,user:any,origin:string){
  if(name==="create_exploration") return createExploration(user.id,a);
  if(name==="append_exploration") return appendExploration(user.id,a);
  if(name==="publish_exploration") return publishExploration(user.id,a,origin);
  if(name==="get_exploration"){const e=await getMine(user.id,a.id_or_slug); if(!e) throw new Error("exploration not found"); return {exploration:e,source_messages:await sourceMessages(e.id)}}
  if(name==="list_my_explorations") return {explorations:await listMine(user.id)};
  if(name==="search_my_explorations") return {explorations:await searchMine(user.id,a.query||"")};
  if(name==="search_public_explorations") return {explorations:await searchPublic(a.query||"")};
  if(name==="get_creator_context"){const items=a.query?await searchMine(user.id,a.query):await listMine(user.id); return {creator:user,history:items.slice(0,12).map((e:any)=>({date:e.published_at||e.updated_at,title:e.title,question:e.opening_question,current_view:e.current_view,status:e.status,slug:e.slug}))};}
  throw new Error("unknown tool");
}

function json(res:http.ServerResponse,status:number,data:any,headers:any={}) {
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers});
  res.end(JSON.stringify(data));
}
function html(res:http.ServerResponse,status:number,body:string){
  res.writeHead(status,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
  res.end(body);
}
function shell(title:string,body:string,me=false){
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Exploration</title>
  <style>:root{--bg:#f7f6f1;--paper:#fffef9;--ink:#171714;--muted:#686860;--line:#deddd5;--accent:#224c3d}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.62 Georgia,serif}a{color:inherit}.wrap{max-width:850px;margin:auto;padding:0 24px}.top{height:72px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);font-family:system-ui}.brand{text-decoration:none;font-weight:800}.nav a{margin-left:18px;text-decoration:none;color:var(--muted);font-size:14px}.hero{padding:68px 0 42px}.hero h1{font-size:clamp(38px,7vw,70px);line-height:1.02;letter-spacing:-.045em;margin:0 0 24px}.kicker{font:800 12px system-ui;text-transform:uppercase;letter-spacing:.14em;color:var(--accent)}.lede{font-size:21px;color:#3d3d37}.card{display:block;background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:26px;margin:0 0 16px;text-decoration:none}.card h2{font-size:27px;line-height:1.15;margin:8px 0 12px}.meta{font:13px system-ui;color:var(--muted)}.section{padding:28px 0;border-top:1px solid var(--line)}.section h3{font:800 12px system-ui;text-transform:uppercase;letter-spacing:.14em;color:var(--accent);margin:0 0 13px}.section p{font-size:21px;white-space:pre-wrap}.profile{padding:54px 0 26px}.profile h1{font-size:46px;margin:0}.panel{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:24px;margin:20px 0}.form{display:grid;gap:12px}.form input{padding:12px;border:1px solid var(--line);border-radius:9px}.btn{border:0;border-radius:9px;background:var(--ink);color:white;padding:11px 16px;font-weight:700}.secret{overflow-wrap:anywhere;background:#171714;color:white;padding:14px;border-radius:9px}details{border-top:1px solid var(--line);padding:22px 0}.msg{padding:14px 0;border-bottom:1px solid var(--line)}.role{font:800 11px system-ui;text-transform:uppercase;color:var(--muted)}.footer{padding:60px 0;color:var(--muted);font:13px system-ui}</style></head><body><div class="wrap"><header class="top"><a class="brand" href="/">Exploration</a><nav class="nav"><a href="/">Feed</a><a href="/me">${me?"My explorations":"Create / Sign in"}</a></nav></header>${body}<footer class="footer">Think with any AI. Publish the human thinking.</footer></div></body></html>`;
}
function card(e:any){return `<a class="card" href="/@${encodeURIComponent(e.username)}/${encodeURIComponent(e.slug)}"><div class="meta">@${esc(e.username)} · ${esc(e.source_platform||"AI-assisted")}</div><h2>${esc(e.title)}</h2><div>${esc(e.opening_question)}</div></a>`;}
function feed(items:any[]){return shell("Feed",`<section class="hero"><div class="kicker">AI-era publishing</div><h1>Follow how people think, not just what AI answers.</h1><p class="lede">Explorations capture the question, the starting view, the turning points and where the creator landed. The source conversation stays underneath.</p></section>${items.map(card).join("")}`);}
function auth(err=""){return shell("Create or sign in",`<section class="hero"><div class="kicker">Creator access</div><h1>Keep your AI. Own your exploration history.</h1><p class="lede">Create one account, then connect Claude through OAuth. No API key or bearer token copying.</p></section>${err?'<div class="panel"><b>'+esc(err)+'</b></div>':""}<div class="panel"><h2>Create creator</h2><form class="form" method="post" action="/register"><input name="username" placeholder="username" required><input name="display_name" placeholder="Display name" required><input type="password" name="password" minlength="8" placeholder="Password (8+ characters)" required><button class="btn">Create</button></form></div><div class="panel"><h2>Sign in</h2><form class="form" method="post" action="/login"><input name="username" placeholder="username" required><input type="password" name="password" placeholder="Password" required><button class="btn">Sign in</button></form></div>`);}
function mePage(u:any,items:any[],origin:string){return shell("My explorations",`<section class="profile"><div class="kicker">Creator</div><h1>${esc(u.display_name)}</h1><div class="meta">@${esc(u.username)}</div></section><div class="panel"><h2>Connect your AI</h2><p>Use Claude with your Exploration account through OAuth. You do not need to copy a token.</p><p><a class="btn" style="display:inline-block;text-decoration:none" href="/connect/claude">Connect Claude</a></p><div class="meta">Remote MCP: ${esc(origin)}/mcp</div></div><div class="panel"><h2>Try this in Claude</h2><p>“Create a private exploration from our current discussion. Capture my starting view, key turns, turning points and current view.”</p><p>Then: “Publish that exploration.”</p></div><h2>My explorations</h2>${items.map((e:any)=>'<div class="card"><div class="meta">'+esc(e.status)+'</div><h2>'+esc(e.title)+'</h2><div>'+esc(e.current_view)+'</div></div>').join("")}`,true);}
function claudeConnectPage(origin:string){return shell("Connect Claude",`<section class="hero"><div class="kicker">OAuth connector</div><h1>Connect Exploration to Claude.</h1><p class="lede">Claude will discover OAuth automatically from the MCP URL. After adding the connector once, sign in to Exploration and approve access.</p></section><div class="panel"><h2>1. Open Claude Connectors</h2><p><a class="btn" style="display:inline-block;text-decoration:none" href="https://claude.ai/settings/connectors?modal=add-custom-connector" target="_blank" rel="noreferrer">Open Claude Connectors</a></p></div><div class="panel"><h2>2. Add this connector</h2><p>Name: <b>Exploration</b></p><div class="secret"><code>${esc(origin)}/mcp</code></div><p class="meta">Choose OAuth / sign in when prompted. Claude should discover the authorization endpoints automatically.</p></div><div class="panel"><h2>3. Approve</h2><p>Claude opens an Exploration sign-in page. Sign in and choose Allow. After that, Claude can use your Exploration tools without seeing your password.</p></div>`);}
function oauthPage(origin:string,params:URLSearchParams,u:any,err=""){
  const qp=params.toString();const client=params.get("client_id")||"Claude";const scope=oauthScope(params.get("scope"));
  if(u)return shell("Authorize Claude",`<section class="hero"><div class="kicker">OAuth authorization</div><h1>Allow this AI to use Exploration?</h1><p class="lede">Signed in as @${esc(u.username)}. Requested access: ${esc(scope)}.</p></section>${err?'<div class="panel"><b>'+esc(err)+'</b></div>':""}<div class="panel"><form class="form" method="post" action="/oauth/authorize?${esc(qp)}"><input type="hidden" name="mode" value="approve"><button class="btn">Allow</button></form><p class="meta">Client: ${esc(client)}</p></div>`);
  return shell("Sign in to authorize",`<section class="hero"><div class="kicker">OAuth authorization</div><h1>Sign in to Exploration.</h1><p class="lede">Claude will receive a scoped access token, never your password.</p></section>${err?'<div class="panel"><b>'+esc(err)+'</b></div>':""}<div class="panel"><h2>Sign in & allow</h2><form class="form" method="post" action="/oauth/authorize?${esc(qp)}"><input type="hidden" name="mode" value="login"><input name="username" placeholder="username" required><input type="password" name="password" placeholder="Password" required><button class="btn">Sign in & allow</button></form></div><div class="panel"><h2>Create account & allow</h2><form class="form" method="post" action="/oauth/authorize?${esc(qp)}"><input type="hidden" name="mode" value="register"><input name="username" placeholder="username" required><input name="display_name" placeholder="Display name" required><input type="password" name="password" minlength="8" placeholder="Password (8+ characters)" required><button class="btn">Create & allow</button></form></div>`);
}
function explorationPage(e:any,msgs:any[]){return shell(e.title,`<article><section class="hero"><div class="kicker">Exploration by <a href="/@${esc(e.username)}">@${esc(e.username)}</a></div><h1>${esc(e.title)}</h1></section><section class="section"><h3>Question</h3><p>${esc(e.opening_question)}</p></section><section class="section"><h3>Starting view</h3><p>${esc(e.starting_view)}</p></section><section class="section"><h3>Key turns</h3><ul>${(e.key_turns||[]).map((x:string)=>'<li>'+esc(x)+'</li>').join("")}</ul></section><section class="section"><h3>Turning points</h3><ul>${(e.turning_points||[]).map((x:string)=>'<li>'+esc(x)+'</li>').join("")}</ul></section><section class="section"><h3>Now I think</h3><p>${esc(e.current_view)}</p></section><details><summary>Read source conversation (${msgs.length} messages)</summary>${msgs.map((m:any)=>'<div class="msg"><div class="role">'+esc(m.role)+'</div><div>'+esc(m.content)+'</div></div>').join("")||'<p>No source messages stored.</p>'}</details></article>`);}

function cookies(req:http.IncomingMessage){const o:any={};for(const p of (req.headers.cookie||"").split(";")){const i=p.indexOf("=");if(i>0)o[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1));}return o;}
async function body(req:http.IncomingMessage){const chunks:any[]=[];let n=0;for await(const c of req){n+=c.length;if(n>2000000)throw new Error("body too large");chunks.push(c)}return Buffer.concat(chunks).toString("utf8");}
function redirect(res:http.ServerResponse,loc:string,cookie?:string,status=303){res.writeHead(status,{location:loc,...(cookie?{"set-cookie":cookie}:{})});res.end();}
function webCookie(t:string){return "exploration_web="+encodeURIComponent(t)+"; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000"+(process.env.NODE_ENV==="production"?"; Secure":"");}
function oauthErrorRedirect(redirectUri:string,state:string|null,error:string,desc:string,origin:string){
  const u=new URL(redirectUri);u.searchParams.set("error",error);u.searchParams.set("error_description",desc);if(state)u.searchParams.set("state",state);u.searchParams.set("iss",origin);return u.toString();
}
async function registerOAuthClient(req:http.IncomingMessage,res:http.ServerResponse){
  let data:any;try{data=JSON.parse(await body(req))}catch{return json(res,400,{error:"invalid_client_metadata"})}
  const uris=Array.isArray(data.redirect_uris)?data.redirect_uris.filter((x:any)=>typeof x==="string"&&validRedirectUri(x)):[];
  if(!uris.length)return json(res,400,{error:"invalid_redirect_uri"});
  const requested=String(data.token_endpoint_auth_method||"none");
  const method=["none","client_secret_post","client_secret_basic"].includes(requested)?requested:"none";
  const clientId="mcp_"+crypto.randomBytes(24).toString("base64url");
  const secret=method==="none"?null:"mcs_"+crypto.randomBytes(32).toString("base64url");
  await q("INSERT INTO oauth_clients(client_id,client_name,redirect_uris,client_secret_hash,token_endpoint_auth_method) VALUES($1,$2,$3::jsonb,$4,$5)",
    [clientId,String(data.client_name||"MCP Client").slice(0,120),JSON.stringify(uris),secret?hash(secret):null,method]);
  const out:any={client_id:clientId,client_id_issued_at:Math.floor(Date.now()/1000),client_name:String(data.client_name||"MCP Client"),redirect_uris:uris,grant_types:["authorization_code","refresh_token"],response_types:["code"],token_endpoint_auth_method:method};
  if(secret){out.client_secret=secret;out.client_secret_expires_at=0;}
  return json(res,201,out);
}
async function validateAuthorize(params:URLSearchParams,origin:string){
  if(params.get("response_type")!=="code")throw new Error("response_type must be code");
  const clientId=String(params.get("client_id")||"");const client=await oauthClient(clientId);if(!client)throw new Error("unknown client_id");
  const redirectUri=String(params.get("redirect_uri")||"");const uris=Array.isArray(client.redirect_uris)?client.redirect_uris:JSON.parse(client.redirect_uris||"[]");
  if(!uris.includes(redirectUri))throw new Error("redirect_uri is not registered");
  const cc=String(params.get("code_challenge")||"");if(!cc||params.get("code_challenge_method")!=="S256")throw new Error("PKCE S256 is required");
  const resource=String(params.get("resource")||origin+"/mcp");if(resource!==origin+"/mcp")throw new Error("invalid resource");
  return {client,clientId,redirectUri,codeChallenge:cc,scope:oauthScope(params.get("scope")),resource,state:params.get("state")};
}
async function issueAuthorizationCode(userId:string,v:any,origin:string){
  const raw="oc_"+crypto.randomBytes(32).toString("base64url");
  await q("INSERT INTO oauth_codes(code_hash,user_id,client_id,redirect_uri,code_challenge,scope,resource,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes')",
    [hash(raw),userId,v.clientId,v.redirectUri,v.codeChallenge,v.scope,v.resource]);
  const u=new URL(v.redirectUri);u.searchParams.set("code",raw);if(v.state)u.searchParams.set("state",v.state);u.searchParams.set("iss",origin);return u.toString();
}
function clientCredentials(req:http.IncomingMessage,p:URLSearchParams){
  const auth=String(req.headers.authorization||"");if(auth.toLowerCase().startsWith("basic ")){try{const raw=Buffer.from(auth.slice(6),"base64").toString("utf8");const i=raw.indexOf(":");return {clientId:decodeURIComponent(raw.slice(0,i)),secret:decodeURIComponent(raw.slice(i+1))};}catch{}}
  return {clientId:String(p.get("client_id")||""),secret:String(p.get("client_secret")||"")};
}
async function verifyOAuthClientForToken(req:http.IncomingMessage,p:URLSearchParams){
  const c=clientCredentials(req,p);const row=await oauthClient(c.clientId);if(!row)return null;
  if(row.token_endpoint_auth_method!=="none"){if(!c.secret||!row.client_secret_hash||hash(c.secret)!==row.client_secret_hash)return null;}
  return row;
}
async function insertOAuthTokens(userId:string,clientId:string,scope:string,resource:string){
  const access="oat_"+crypto.randomBytes(32).toString("base64url");const refresh="ort_"+crypto.randomBytes(40).toString("base64url");
  await q("INSERT INTO oauth_tokens(access_token_hash,refresh_token_hash,user_id,client_id,scope,resource,expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '30 days')",
    [hash(access),hash(refresh),userId,clientId,scope,resource]);
  return {access_token:access,token_type:"Bearer",expires_in:3600,refresh_token:refresh,scope};
}
async function oauthToken(req:http.IncomingMessage,res:http.ServerResponse,origin:string){
  const p=new URLSearchParams(await body(req));const client=await verifyOAuthClientForToken(req,p);if(!client)return json(res,401,{error:"invalid_client"});
  const grant=String(p.get("grant_type")||"");
  if(grant==="authorization_code"){
    const code=String(p.get("code")||"");const verifier=String(p.get("code_verifier")||"");const redirectUri=String(p.get("redirect_uri")||"");
    const r=await q("SELECT * FROM oauth_codes WHERE code_hash=$1 AND client_id=$2 AND expires_at>now() AND used_at IS NULL LIMIT 1",[hash(code),client.client_id]);const row=r.rows[0];
    if(!row||row.redirect_uri!==redirectUri||!verifier||pkceS256(verifier)!==row.code_challenge)return json(res,400,{error:"invalid_grant"});
    const used=await q("UPDATE oauth_codes SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL RETURNING code_hash",[hash(code)]);if(!used.rowCount)return json(res,400,{error:"invalid_grant"});
    return json(res,200,await insertOAuthTokens(row.user_id,row.client_id,row.scope,row.resource));
  }
  if(grant==="refresh_token"){
    const rt=String(p.get("refresh_token")||"");const r=await q("SELECT * FROM oauth_tokens WHERE refresh_token_hash=$1 AND client_id=$2 AND refresh_expires_at>now() AND revoked_at IS NULL LIMIT 1",[hash(rt),client.client_id]);const row=r.rows[0];
    if(!row)return json(res,400,{error:"invalid_grant"});await q("UPDATE oauth_tokens SET revoked_at=now() WHERE refresh_token_hash=$1",[hash(rt)]);
    return json(res,200,await insertOAuthTokens(row.user_id,row.client_id,row.scope,row.resource));
  }
  return json(res,400,{error:"unsupported_grant_type"});
}
function protectedResourceMetadata(origin:string){return {resource:origin+"/mcp",authorization_servers:[origin],scopes_supported:["exploration.read","exploration.write"],bearer_methods_supported:["header"]};}
function authorizationServerMetadata(origin:string){return {issuer:origin,authorization_endpoint:origin+"/oauth/authorize",token_endpoint:origin+"/oauth/token",registration_endpoint:origin+"/oauth/register",revocation_endpoint:origin+"/oauth/revoke",response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],code_challenge_methods_supported:["S256"],token_endpoint_auth_methods_supported:["none","client_secret_post","client_secret_basic"],scopes_supported:["exploration.read","exploration.write"],authorization_response_iss_parameter_supported:true};}

async function mcp(req:http.IncomingMessage,res:http.ServerResponse,origin:string){
  const auth=req.headers.authorization||"";const raw=auth.toLowerCase().startsWith("bearer ")?auth.slice(7).trim():"";
  const u=await userByToken(raw,origin+"/mcp");
  if(!u){const meta=origin+"/.well-known/oauth-protected-resource";return json(res,401,{error:"invalid_token",error_description:"Authorization required"},{"www-authenticate":`Bearer error="invalid_token", error_description="Authorization required", resource_metadata="${meta}", scope="exploration.read exploration.write"`});}
  let rpc:any; try{rpc=JSON.parse(await body(req))}catch{return json(res,400,{jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}})}
  const id=rpc.id??null;const method=rpc.method || String(req.headers["mcp-method"]||"");
  if(method==="initialize") return json(res,200,{jsonrpc:"2.0",id,result:{protocolVersion:rpc.params?.protocolVersion||"2026-07-28",capabilities:{tools:{}},serverInfo:{name:"exploration-pub",version:"0.2.0"}}});
  if(method==="server/discover") return json(res,200,{jsonrpc:"2.0",id,result:{protocolVersion:"2026-07-28",capabilities:{tools:{listChanged:false}},serverInfo:{name:"exploration-pub",version:"0.2.0"}}});
  if(method==="notifications/initialized") return json(res,202,{});
  if(method==="tools/list") return json(res,200,{jsonrpc:"2.0",id,result:{tools:toolDefs()}});
  if(method==="tools/call"){
    try{const toolName=rpc.params?.name || String(req.headers["mcp-name"]||"");const data=await callTool(toolName,rpc.params?.arguments||{},u,origin);return json(res,200,{jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify(data,null,2)}],structuredContent:{result:data}}});}
    catch(e:any){return json(res,200,{jsonrpc:"2.0",id,result:{isError:true,content:[{type:"text",text:e.message||"Tool failed"}]}})}
  }
  return json(res,200,{jsonrpc:"2.0",id,error:{code:-32601,message:"Method not found"}});
}

const server=http.createServer(async(req,res)=>{
  try{
    const origin=(process.env.PUBLIC_BASE_URL||("http://"+(req.headers.host||("localhost:"+PORT)))).replace(/\/$/,"");const url=new URL(req.url||"/",origin);
    if(url.pathname==="/health"){res.writeHead(200,{"content-type":"text/plain"});return res.end("ok")}
    if((url.pathname==="/.well-known/oauth-protected-resource"||url.pathname==="/.well-known/oauth-protected-resource/mcp")&&req.method==="GET")return json(res,200,protectedResourceMetadata(origin),{"access-control-allow-origin":"*"});
    if(url.pathname==="/.well-known/oauth-authorization-server"&&req.method==="GET")return json(res,200,authorizationServerMetadata(origin),{"access-control-allow-origin":"*"});
    if(url.pathname==="/oauth/register"&&req.method==="POST")return registerOAuthClient(req,res);
    if(url.pathname==="/oauth/token"&&req.method==="POST")return oauthToken(req,res,origin);
    if(url.pathname==="/oauth/revoke"&&req.method==="POST"){const p=new URLSearchParams(await body(req));const t=String(p.get("token")||"");if(t)await q("UPDATE oauth_tokens SET revoked_at=now() WHERE access_token_hash=$1 OR refresh_token_hash=$1",[hash(t)]);res.writeHead(200);return res.end();}
    if(url.pathname==="/oauth/authorize"&&req.method==="GET"){
      let v:any;try{v=await validateAuthorize(url.searchParams,origin)}catch(e:any){return html(res,400,shell("OAuth error",`<div class="panel"><h2>OAuth request rejected</h2><p>${esc(e.message)}</p></div>`));}
      const u=await currentWebUser(req);return html(res,200,oauthPage(origin,url.searchParams,u));
    }
    if(url.pathname==="/oauth/authorize"&&req.method==="POST"){
      let v:any;try{v=await validateAuthorize(url.searchParams,origin)}catch(e:any){return html(res,400,shell("OAuth error",`<div class="panel"><h2>OAuth request rejected</h2><p>${esc(e.message)}</p></div>`));}
      const p=new URLSearchParams(await body(req));const mode=String(p.get("mode")||"approve");let u=await currentWebUser(req);let newSession:string|undefined;
      if(mode==="deny")return redirect(res,oauthErrorRedirect(v.redirectUri,v.state,"access_denied","The user denied access",origin));
      if(!u&&mode==="login"){u=await userByCredentials(String(p.get("username")||""),String(p.get("password")||""));if(!u)return html(res,401,oauthPage(origin,url.searchParams,null,"Invalid username or password."));newSession=await createWebSession(u.id);}
      if(!u&&mode==="register"){
        const username=String(p.get("username")||"").trim().toLowerCase(),display=String(p.get("display_name")||"").trim(),password=String(p.get("password")||"");
        if(!/^[a-z0-9_-]{3,32}$/.test(username)||password.length<8)return html(res,400,oauthPage(origin,url.searchParams,null,"Use a 3–32 character username and password of at least 8 characters."));
        const pr=passwordRecord(password);const uid=crypto.randomUUID();try{await q("INSERT INTO users(id,username,display_name,token_hash,password_salt,password_hash) VALUES($1,$2,$3,$4,$5,$6)",[uid,username,display||username,hash(token()),pr.salt,pr.digest]);}catch{return html(res,400,oauthPage(origin,url.searchParams,null,"That username already exists."))}
        u={id:uid,username,display_name:display||username,bio:null};newSession=await createWebSession(uid);
      }
      if(!u)return html(res,401,oauthPage(origin,url.searchParams,null,"Please sign in first."));
      const loc=await issueAuthorizationCode(u.id,v,origin);return redirect(res,loc,newSession?webCookie(newSession):undefined,302);
    }
    if(url.pathname==="/mcp" && req.method==="POST") return mcp(req,res,origin);
    if(url.pathname==="/connect/claude"&&req.method==="GET")return html(res,200,claudeConnectPage(origin));
    if(url.pathname==="/" && req.method==="GET"){const r=await q(`SELECT e.*,u.username,u.display_name FROM explorations e JOIN users u ON u.id=e.user_id WHERE e.status='published' ORDER BY e.published_at DESC LIMIT 30`);return html(res,200,feed(r.rows));}
    if(url.pathname==="/me" && req.method==="GET"){const u=await currentWebUser(req);if(!u)return html(res,200,auth());return html(res,200,mePage(u,await listMine(u.id),origin));}
    if(url.pathname==="/register" && req.method==="POST"){
      const p=new URLSearchParams(await body(req));const username=String(p.get("username")||"").trim().toLowerCase(),display=String(p.get("display_name")||"").trim(),password=String(p.get("password")||"");
      if(!/^[a-z0-9_-]{3,32}$/.test(username)||password.length<8)return html(res,400,auth("Use a 3–32 character username and password of at least 8 characters."));
      const pr=passwordRecord(password),uid=crypto.randomUUID();try{await q("INSERT INTO users(id,username,display_name,token_hash,password_salt,password_hash) VALUES($1,$2,$3,$4,$5,$6)",[uid,username,display||username,hash(token()),pr.salt,pr.digest]);}catch{return html(res,400,auth("That username already exists."))}
      const ws=await createWebSession(uid);return redirect(res,"/me",webCookie(ws));
    }
    if(url.pathname==="/login" && req.method==="POST"){
      const p=new URLSearchParams(await body(req));const u=await userByCredentials(String(p.get("username")||""),String(p.get("password")||""));if(!u)return html(res,401,auth("Invalid username or password."));const ws=await createWebSession(u.id);return redirect(res,"/me",webCookie(ws));
    }
    if(url.pathname.startsWith("/@") && req.method==="GET"){
      const parts=url.pathname.split("/").filter(Boolean);const username=decodeURIComponent(parts[0].slice(1));
      if(parts.length===1){const u=(await q("SELECT id,username,display_name,bio FROM users WHERE username=$1",[username])).rows[0];if(!u)return html(res,404,"Not found");const items=(await q(`SELECT e.*,u.username,u.display_name FROM explorations e JOIN users u ON u.id=e.user_id WHERE u.username=$1 AND e.status='published' ORDER BY e.published_at DESC`,[username])).rows;return html(res,200,shell("@"+username,`<section class="profile"><div class="kicker">Creator</div><h1>${esc(u.display_name)}</h1><div class="meta">@${esc(u.username)}</div><p>${esc(u.bio||"")}</p></section>${items.map(card).join("")}`));}
      if(parts.length===2){const e=(await q(`SELECT e.*,u.username,u.display_name FROM explorations e JOIN users u ON u.id=e.user_id WHERE u.username=$1 AND e.slug=$2 AND e.status='published' LIMIT 1`,[username,decodeURIComponent(parts[1])])).rows[0];if(!e)return html(res,404,"Not found");return html(res,200,explorationPage(e,await sourceMessages(e.id)));}
    }
    return html(res,404,"Not found");
  }catch(e:any){console.error(e);return html(res,500,process.env.NODE_ENV==="production"?"Internal server error":"<pre>"+esc(e.stack||e.message)+"</pre>")}
});
await initDb();
server.listen(PORT,"0.0.0.0",()=>console.log("exploration-pub listening on",PORT));
