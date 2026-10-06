import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test, { type TestContext } from "node:test";
import pg from "pg";
import { createWorkspace, initWorkspaceDb, initPublicationDb } from "../src/workspace.js";
import { createSupport, initSupportDb } from "../src/support.js";
import { createChatApi, initChatDb } from "../src/chat.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const options = { skip: !databaseUrl, timeout: 30_000 };
const fakeKey = () => "sk-local-integration-" + randomBytes(24).toString("hex");
const messages = [
  { role: "system", content: "Be concise." },
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hello back" },
  { role: "user", content: "Say something else" },
];

async function isolatedDatabase(t: TestContext) {
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const schema = "integration_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  t.after(async () => {
    await pool.end();
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.end(); }
  });
  return { pool, url: url.toString() };
}

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function harness(t: TestContext) {
  const { pool } = await isolatedDatabase(t);
  await pool.query("CREATE TABLE users(id uuid PRIMARY KEY, username text DEFAULT 'tester',display_name text DEFAULT 'Tester')");
  const users = { alice: randomUUID(), bob: randomUUID() };
  await pool.query("INSERT INTO users(id,username) VALUES($1,'alice'),($2,'bob')", [users.alice, users.bob]);
  const q = (sql: string, params: any[] = []) => pool.query(sql, params);
  await initChatDb(q);
  await initWorkspaceDb(q);
  await q(`CREATE TABLE explorations(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id),slug text,title text,opening_question text DEFAULT '',
    starting_view text DEFAULT '',key_turns jsonb DEFAULT '[]',turning_points jsonb DEFAULT '[]',current_view text DEFAULT '',
    source_platform text,source_model text,status text DEFAULT 'draft',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),published_at timestamptz);
    CREATE TABLE source_messages(id uuid PRIMARY KEY,exploration_id uuid REFERENCES explorations(id),position integer,role text,content text);`);
  await initPublicationDb(q);
  await initSupportDb(q);
  await initPublicationDb(q);
  await initSupportDb(q);
  await initChatDb(q); // Startup migrations must remain safe across deployments.
  const env: NodeJS.ProcessEnv = {
    HOSTED_OPENAI_API_KEY: fakeKey(), HOSTED_OPENAI_MODEL: "gpt-4.1-mini",
    HOSTED_ANTHROPIC_API_KEY: fakeKey(), HOSTED_ANTHROPIC_MODEL: "claude-haiku-4-5-20251001",
    BYOK_MASTER_KEY: randomBytes(32).toString("hex"),
  };
  const calls: { url: string; headers: Headers; body: any }[] = [];
  let upstream: (url: string) => Promise<Response> = async url => Response.json(url.includes("openai.com")
    ? { output: [{ type: "message", content: [{ type: "output_text", text: "OpenAI reply" }] }] }
    : { content: [{ type: "text", text: "Anthropic reply" }] });
  let databaseError = false;
  const api = createChatApi({
    env,
    workspace: createWorkspace(q,createSupport(pool)),
    q: (sql, params) => {
      if (databaseError) throw new Error("sensitive-database-detail " + env.HOSTED_OPENAI_API_KEY);
      return q(sql, params);
    },
    authenticate: async req => {
      const user = req.headers["test-user"];
      return typeof user === "string" && user in users ? { id: users[user as keyof typeof users] } : null;
    },
    fetchImpl: (async (url: any, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return upstream(String(url));
    }) as typeof fetch,
  });
  let origin = "";
  const server = http.createServer(async (req, res) => {
    if (!await api(req, res, new URL(req.url!, origin).pathname, origin)) {
      res.writeHead(404); res.end();
    }
  });
  origin = await listen(server);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  async function request(path: string, method = "GET", data?: unknown, user: "alice" | "bob" | null = "alice", headers: Record<string, string> = {}) {
    const response = await fetch(origin + path, {
      method, headers: { origin, "content-type": "application/json", ...(user ? { "test-user": user } : {}), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return { status: response.status, data: JSON.parse(text), text, headers: response.headers };
  }
  return { pool, users, env, calls, request, setUpstream: (fn: typeof upstream) => { upstream = fn; }, failDatabase: () => { databaseError = true; } };
}

test("HTTP BYOK records are encrypted, isolated, replaceable, and safely summarized", options, async t => {
  const h = await harness(t);
  const aliceKey = fakeKey(), bobKey = fakeKey(), replacement = fakeKey();
  const saved = await h.request("/api/llm/keys/openai", "PUT", { apiKey: aliceKey });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data, { provider: "openai", configured: true, last4: aliceKey.slice(-4) });
  assert.equal((await h.request("/api/llm/keys/openai", "PUT", { apiKey: bobKey }, "bob")).status, 200);
  const row = (await h.pool.query("SELECT * FROM user_llm_keys WHERE user_id=$1", [h.users.alice])).rows[0];
  assert(!JSON.stringify(row).includes(aliceKey));
  assert.notEqual(Buffer.from(row.ciphertext, "base64").toString(), aliceKey);
  assert.equal(Buffer.from(row.iv, "base64").length, 12);
  assert.equal(Buffer.from(row.tag, "base64").length, 16);
  const status = await h.request("/api/llm/settings");
  assert.deepEqual(status.data.byok.openai, { configured: true, last4: aliceKey.slice(-4) });
  for (const secret of [aliceKey, bobKey, row.ciphertext, row.iv, row.tag, h.env.BYOK_MASTER_KEY!]) assert(!status.text.includes(secret));
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal((await h.request("/api/llm/keys/openai", "PUT", { apiKey: replacement })).status, 200);
  const replaced = (await h.pool.query("SELECT * FROM user_llm_keys WHERE user_id=$1", [h.users.alice])).rows[0];
  assert.notEqual(replaced.ciphertext, row.ciphertext);
  assert.notEqual(replaced.iv, row.iv);
  const chat = await h.request("/api/chat", "POST", { provider: "byok_openai", messages });
  assert.equal(chat.status, 200);
  assert.equal(h.calls.at(-1)!.headers.get("authorization"), `Bearer ${replacement}`);
  assert.equal((await h.request("/api/llm/keys/openai", "DELETE")).status, 200);
  assert.equal((await h.request("/api/llm/settings")).data.byok.openai.configured, false);
  assert.equal((await h.request("/api/llm/settings", "GET", undefined, "bob")).data.byok.openai.last4, bobKey.slice(-4));
  assert.equal((await h.request("/api/chat", "POST", { provider: "byok_openai", messages })).status, 503);
});

test("HTTP chat dispatches all four providers and honors saved selection and auto priority", options, async t => {
  const h = await harness(t);
  const openaiKey = fakeKey(), anthropicKey = fakeKey();
  await h.request("/api/llm/keys/openai", "PUT", { apiKey: openaiKey });
  await h.request("/api/llm/keys/anthropic", "PUT", { apiKey: anthropicKey });
  for (const provider of ["hosted_openai", "hosted_anthropic", "byok_openai", "byok_anthropic"]) {
    const reply = await h.request("/api/chat", "POST", { provider, messages });
    assert.equal(reply.status, 200);
    assert.equal(reply.data.provider, provider);
    assert.equal(reply.data.message.role, "assistant");
    const call = h.calls.at(-1)!;
    if (provider.endsWith("openai")) {
      assert.equal(call.url, "https://api.openai.com/v1/responses");
      assert.equal(call.headers.get("authorization"), `Bearer ${provider.startsWith("byok") ? openaiKey : h.env.HOSTED_OPENAI_API_KEY}`);
      assert.deepEqual(call.body.input, messages);
      assert.equal(call.body.store, false);
      assert.equal(reply.data.message.content, "OpenAI reply");
    } else {
      assert.equal(call.url, "https://api.anthropic.com/v1/messages");
      assert.equal(call.headers.get("x-api-key"), provider.startsWith("byok") ? anthropicKey : h.env.HOSTED_ANTHROPIC_API_KEY);
      assert.equal(call.headers.get("anthropic-version"), "2023-06-01");
      assert.equal(call.body.system, messages[0].content);
      assert.deepEqual(call.body.messages, messages.slice(1));
      assert.equal(reply.data.message.content, "Anthropic reply");
    }
  }
  assert.equal((await h.request("/api/llm/settings", "PUT", { provider: "byok_anthropic" })).status, 200);
  assert.equal((await h.request("/api/chat", "POST", { messages })).data.provider, "byok_anthropic");
  assert.equal((await h.request("/api/llm/settings", "GET", undefined, "bob")).data.provider, "auto");
  for (const expected of ["hosted_openai", "hosted_anthropic", "byok_openai", "byok_anthropic"]) {
    assert.equal((await h.request("/api/chat", "POST", { provider: "auto", messages })).data.provider, expected);
    if (expected === "hosted_openai") h.env.HOSTED_OPENAI_API_KEY = "";
    else if (expected === "hosted_anthropic") h.env.HOSTED_ANTHROPIC_API_KEY = "not-configured";
    else await h.request("/api/llm/keys/" + expected.slice(5), "DELETE");
  }
  const unavailable = await h.request("/api/chat", "POST", { provider: "auto", messages });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.data.error.code, "no_provider_available");
});

test("missing or changed master keys fail safely while deletion stays available", options, async t => {
  const h = await harness(t), key = fakeKey();
  await h.request("/api/llm/keys/openai", "PUT", { apiKey: key });
  h.env.BYOK_MASTER_KEY = randomBytes(32).toString("base64");
  const unreadable = await h.request("/api/chat", "POST", { provider: "byok_openai", messages });
  assert.equal(unreadable.status, 503);
  assert.equal(unreadable.data.error.code, "byok_decryption_failed");
  assert(!unreadable.text.includes(key));
  delete h.env.BYOK_MASTER_KEY;
  assert.equal((await h.request("/api/llm/settings")).data.byok.enabled, false);
  const refused = await h.request("/api/llm/keys/anthropic", "PUT", { apiKey: fakeKey() });
  assert.equal(refused.status, 503);
  assert.equal(refused.data.error.code, "byok_not_configured");
  assert.equal((await h.request("/api/llm/keys/openai", "DELETE")).status, 200);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM user_llm_keys")).rows[0].n, 0);
  assert.equal((await h.request("/api/chat", "POST", { provider: "hosted_openai", messages })).status, 200);
});

test("anonymous and cross-origin requests cannot read settings, write keys, or spend", options, async t => {
  const h = await harness(t);
  for (const [path, method, body] of [
    ["/api/llm/settings", "GET", undefined],
    ["/api/llm/settings", "PUT", { provider: "byok_openai" }],
    ["/api/llm/keys/openai", "PUT", { apiKey: fakeKey() }],
    ["/api/llm/keys/openai", "DELETE", undefined],
    ["/api/chat", "POST", { provider: "hosted_openai", messages }],
  ] as const) assert.equal((await h.request(path, method, body, null)).status, 401);
  for (const headers of [{ origin: "https://attacker.invalid" }, { origin: "" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await h.request("/api/llm/keys/openai", "PUT", { apiKey: fakeKey() }, "alice", headers)).status, 403);
    assert.equal((await h.request("/api/chat", "POST", { provider: "hosted_openai", messages }, "alice", headers)).status, 403);
  }
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM user_llm_keys")).rows[0].n, 0);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM user_chat_rate_limits")).rows[0].n, 0);
  assert.equal(h.calls.length, 0);
});

test("invalid inputs stop before inference and upstream/database errors stay sanitized", options, async t => {
  const h = await harness(t);
  assert.equal((await h.request("/api/llm/settings", "PUT", { provider: "custom_url" })).status, 400);
  assert.equal((await h.request("/api/llm/keys/openai", "PUT", { apiKey: "short" })).status, 400);
  assert.equal((await h.request("/api/llm/keys/openai", "PUT", { apiKey: fakeKey() }, "alice", { "content-type": "text/plain" })).status, 415);
  assert.equal((await h.request("/api/llm/keys/openai", "PUT", { apiKey: "x".repeat(5000) })).status, 413);
  assert.equal((await h.request("/api/chat", "POST", { messages: [{ role: "user", content: "x".repeat(16_001) }] })).status, 400);
  assert.equal((await h.request("/api/chat", "POST", { messages: [{ role: "assistant", content: "invalid start" }] })).status, 400);
  assert.equal(h.calls.length, 0);
  const sensitive = "upstream-private-detail-" + fakeKey();
  h.setUpstream(async () => new Response(sensitive, { status: 401 }));
  const rejected = await h.request("/api/chat", "POST", { messages });
  assert.equal(rejected.status, 502);
  assert.equal(rejected.data.error.code, "provider_auth_failed");
  assert(!rejected.text.includes(sensitive));
  h.setUpstream(async () => { throw new Error(sensitive); });
  assert.equal((await h.request("/api/chat", "POST", { messages })).data.error.code, "provider_unavailable");
  h.failDatabase();
  const databaseFailure = await h.request("/api/llm/settings");
  assert.equal(databaseFailure.status, 500);
  assert.equal(databaseFailure.data.error.code, "internal_error");
  assert(!databaseFailure.text.includes("sensitive-database-detail"));
  assert(!databaseFailure.text.includes(h.env.HOSTED_OPENAI_API_KEY!));
});

test("chat rate cap is atomic and concurrent requests cannot duplicate spending", options, async t => {
  const h = await harness(t);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  h.setUpstream(async () => { started(); await blocked; return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }); });
  const first = h.request("/api/chat", "POST", { messages });
  await entered;
  const duplicate = await h.request("/api/chat", "POST", { messages });
  assert.equal(duplicate.status, 429);
  assert.equal(duplicate.data.error.code, "chat_in_progress");
  assert.equal(h.calls.length, 1);
  release();
  assert.equal((await first).status, 200);
  // Use PostgreSQL time so this remains reliable if the wall clock crosses a minute boundary.
  await h.pool.query("UPDATE user_chat_rate_limits SET window_start=date_trunc('minute',now()),requests=20 WHERE user_id=$1", [h.users.alice]);
  const capped = await h.request("/api/chat", "POST", { messages });
  if (capped.status === 200) { // Rare boundary crossing: establish the cap in the new window once.
    await h.pool.query("UPDATE user_chat_rate_limits SET window_start=date_trunc('minute',now()),requests=20 WHERE user_id=$1", [h.users.alice]);
    assert.equal((await h.request("/api/chat", "POST", { messages })).status, 429);
  } else {
    assert.equal(capped.status, 429);
    assert.equal(capped.data.error.code, "rate_limited");
  }
  await h.pool.query("UPDATE user_chat_rate_limits SET window_start=now()-interval '2 minutes' WHERE user_id=$1", [h.users.alice]);
  assert.equal((await h.request("/api/chat", "POST", { messages })).status, 200);
});

test("real server preserves sign-in, OAuth PKCE, and private Exploration MCP workflows", options, async t => {
  const db = await isolatedDatabase(t);
  const reservation = http.createServer();
  const origin = await listen(reservation);
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DATABASE_URL: db.url, PORT: new URL(origin).port, PUBLIC_BASE_URL: origin,
      NODE_ENV: "test", HOSTED_OPENAI_API_KEY: "", HOSTED_ANTHROPIC_API_KEY: "", BYOK_MASTER_KEY: "" },
  });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) assert.fail("Local server exited before readiness: " + output);
    try { if ((await fetch(origin + "/health")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await (await fetch(origin + "/health")).text(), "ok");
  assert.equal((await fetch(origin + "/chat")).status, 200);
  assert.equal((await fetch(origin + "/connect/claude")).status, 200);
  const username = "integration_" + randomBytes(6).toString("hex"), password = randomBytes(20).toString("hex");
  const form = (path: string, values: Record<string, string>, cookie = "") => fetch(origin + path, {
    method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(values),
  });
  const crossSiteLogin = await fetch(origin + "/login", { method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username, password }) });
  assert.equal(crossSiteLogin.status, 403);
  const registered = await form("/register", { username, display_name: "Integration Test", password });
  assert.equal(registered.status, 303);
  const login = await form("/login", { username, password });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  assert(cookie.startsWith("exploration_web="));
  assert.match(await (await fetch(origin + "/me", { headers: { cookie } })).text(), /Integration Test/);
  const settings = await fetch(origin + "/api/llm/settings", { headers: { cookie } });
  assert.equal(settings.status, 200);
  assert.equal((await settings.json()).hosted.openai.configured, false);
  const deniedMcp = await fetch(origin + "/mcp", { method: "POST", body: "{}" });
  assert.equal(deniedMcp.status, 401);
  assert.match(deniedMcp.headers.get("www-authenticate")!, /resource_metadata=/);
  const metadata = await (await fetch(origin + "/.well-known/oauth-authorization-server")).json();
  assert.equal(metadata.issuer, origin);
  const redirectUri = "https://client.invalid/callback";
  const registration = await fetch(origin + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Integration Test", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }) });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: origin + "/mcp", state: "integration-state" });
  assert.equal((await fetch(origin + "/oauth/authorize?" + query, { headers: { cookie } })).status, 200);
  const approval = await form("/oauth/authorize?" + query, { mode: "approve" }, cookie);
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location")!);
  assert.equal(callback.searchParams.get("state"), "integration-state");
  const tokenRequest = { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirectUri, code: callback.searchParams.get("code")!, code_verifier: verifier };
  assert.equal((await form("/oauth/token", { ...tokenRequest, code_verifier: "incorrect" })).status, 400);
  const exchanged = await form("/oauth/token", tokenRequest);
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  assert.equal((await form("/oauth/token", tokenRequest)).status, 400);
  // An MCP token is intentionally insufficient for Hosted/BYOK account controls.
  assert.equal((await fetch(origin + "/api/llm/settings", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401);
  assert.equal((await fetch(origin + "/api/llm/settings", { headers: { cookie: "exploration_session=" + tokens.access_token } })).status, 401);
  const rpc = async (method: string, params: unknown = {}) => {
    const response = await fetch(origin + "/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await rpc("initialize")).result.serverInfo.name, "exploration-pub");
  assert((await rpc("tools/list")).result.tools.some((tool: any) => tool.name === "create_exploration"));
  const created = await rpc("tools/call", { name: "create_exploration", arguments: { title: "Private regression draft", opening_question: "Does the existing workflow still work?" } });
  const exploration = created.result.structuredContent.result;
  assert.equal(exploration.status, "draft");
  const listed = await rpc("tools/call", { name: "list_my_explorations", arguments: {} });
  assert.equal(listed.result.structuredContent.result.explorations.length, 1);
  const fetched = await rpc("tools/call", { name: "get_exploration", arguments: { id_or_slug: exploration.id } });
  assert.equal(fetched.result.structuredContent.result.exploration.id, exploration.id);
  assert.equal((await fetch(origin + "/@" + username + "/" + exploration.slug)).status, 404);
});


test("saved conversations survive reload, isolate owners, reject stale edits, and deduplicate retries", options, async t => {
  const h=await harness(t);
  const created=await h.request('/api/conversations','POST',{});
  assert.equal(created.status,201);
  const c=created.data.conversation;
  const payload={conversation_id:c.id,revision:0,request_id:randomUUID(),message:'What makes a useful exploration?',source_ids:[]};
  assert.equal((await h.request('/api/conversations/'+c.id,'GET',undefined,'bob')).status,404);
  assert.equal((await h.request('/api/chat','POST',payload,'bob')).status,404);
  assert.equal((await h.request('/api/conversations','GET',undefined,null)).status,401);
  assert.equal((await h.request('/api/conversations','POST',{},'alice',{origin:'https://attacker.invalid'})).status,403);
  const sent=await h.request('/api/chat','POST',payload);
  assert.equal(sent.status,200);
  assert.equal(sent.data.conversation.messages.length,2);
  assert.equal(sent.data.conversation.revision,1);
  assert(!('pending_token' in sent.data.conversation));
  const restored=await h.request('/api/conversations/'+c.id);
  assert.deepEqual(restored.data.conversation.messages,sent.data.conversation.messages);
  assert.equal((await h.request('/api/conversations')).data.conversations.length,1);
  assert.equal((await h.request('/api/conversations','GET',undefined,'bob')).data.conversations.length,0);
  assert.equal((await h.request('/api/chat','POST',payload)).status,200);
  assert.equal(h.calls.length,1);
  assert.equal((await h.request('/api/chat','POST',{...payload,request_id:randomUUID()})).status,409);
  const updated=await h.request('/api/conversations/'+c.id,'PATCH',{revision:1,title:'My thinking',reflection:{starting_view:'Start',turning_points:'A new perspective',current_view:'My own conclusion'}});
  assert.equal(updated.status,200);
  assert.equal(updated.data.conversation.revision,2);
  assert.equal((await h.request('/api/conversations/'+c.id,'PATCH',{revision:1,title:'Stale',reflection:{}})).status,409);
  h.setUpstream(async()=>new Response('private error',{status:503}));
  assert.equal((await h.request('/api/chat','POST',{...payload,revision:2,request_id:randomUUID(),message:'Continue'})).status,502);
  const failed=await h.request('/api/conversations/'+c.id);
  assert.equal(failed.data.conversation.messages.length,2);
  assert.equal(failed.data.conversation.busy,false);
});

test("references respect visibility and draft publishing snapshots the reviewed conversation", options, async t=>{
 const h=await harness(t),publicId=randomUUID(),privateId=randomUUID();
 await h.pool.query("INSERT INTO explorations(id,user_id,slug,title,current_view,status) VALUES($1,$3,'public','Connected thinking','Reference insight','published'),($2,$3,'private','Secret draft','Private insight','draft')",[publicId,privateId,h.users.bob]);
 const created=(await h.request('/api/conversations','POST',{})).data.conversation;
 const p={conversation_id:created.id,revision:0,request_id:randomUUID(),message:'How does thinking connect?',source_ids:[privateId]};
 assert.equal((await h.request('/api/explorations/'+privateId)).status,404);
 assert.equal((await h.request('/api/chat','POST',p)).status,404);
 assert.equal(h.calls.length,0);
 const search=await h.request('/api/explorations/search?scope=public&q=thinking');
 assert.equal(search.status,200);
 assert.deepEqual(search.data.explorations.map((e:any)=>e.id),[publicId]);
 assert.equal((await h.request('/api/explorations/search?scope=mine')).data.explorations.length,0);
 const reply=await h.request('/api/chat','POST',{...p,source_ids:[publicId]});
 assert.equal(reply.status,200);
 assert.match(JSON.stringify(h.calls[0].body.input),/Reference insight/);
 assert(!JSON.stringify(h.calls[0].body.input).includes('Private insight'));
 assert.equal(reply.data.conversation.sources[0].id,publicId);
 assert.equal((await h.request('/api/conversations/'+created.id+'/draft','POST',{revision:1})).status,400);
 const reflection={starting_view:'I was uncertain.',turning_points:'I considered the source.\nI tested an alternative.',current_view:'My own view.'};
 const revised=(await h.request('/api/conversations/'+created.id,'PATCH',{revision:1,title:'A reviewed exploration',reflection})).data.conversation;
 const draft=await h.request('/api/conversations/'+created.id+'/draft','POST',{revision:revised.revision});
 assert.equal(draft.status,201);
 const id=draft.data.id;
 assert.equal((await h.request('/api/conversations/'+created.id+'/draft','POST',{revision:revised.revision})).data.id,id);
 const detail=await h.request('/api/explorations/'+id);
 assert.equal(detail.data.exploration.status,'draft');
 assert.equal(detail.data.exploration.current_view,'My own view.');
 assert.equal(detail.data.messages.length,2);
 assert.equal(detail.data.can_publish,true);
 assert.equal((await h.request('/api/explorations/'+id,'GET',undefined,'bob')).status,404);
 assert.equal((await h.request('/api/explorations/'+publicId+'/publish','POST',{})).status,404);
 assert.equal((await h.request('/api/explorations/'+id+'/publish','POST',{})).status,200);
 assert.equal((await h.request('/api/explorations/'+id,'GET',undefined,'bob')).data.exploration.status,'published');
 assert.equal((await h.request('/api/explorations/'+id,'GET',undefined,'bob')).data.can_publish,false);
});

test('AI documents, manual edits, immutable versions and inherited conversations remain paired',options,async t=>{
 const h=await harness(t);
 let c=(await h.request('/api/conversations','POST',{topic:'과학'})).data.conversation;
 const chat=(action:string,extra={})=>h.request('/api/chat','POST',{action,conversation_id:c.id,revision:c.revision,request_id:randomUUID(),...extra});
 c=(await chat('chat',{message:'도시의 나무에 관한 글을 함께 쓰자.'})).data.conversation;
 const transcript=c.messages;
 h.setUpstream(async()=>Response.json({output:[{type:'message',content:[{type:'output_text',text:'# 도시의 나무\n\n## 관점\n대화에서 출발한 문서.'}]}]}));
 const generated=await chat('document');assert.equal(generated.status,200);c=generated.data.conversation;
 assert.equal(c.title,'도시의 나무');assert.equal(c.document_message_count,2);assert.deepEqual(c.messages,transcript);
 assert.match(JSON.stringify(h.calls.at(-1)?.body),/existing_draft/);
 const doc='# 도시의 나무\n\n'+('내가 직접 고친 내용. '.repeat(1000));
 const edited=await h.request('/api/conversations/'+c.id,'PATCH',{revision:c.revision,document_body:doc});assert.equal(edited.status,200);c=edited.data.conversation;
 h.setUpstream(async()=>new Response('error',{status:503}));
 assert.equal((await chat('document')).status,502);
 c=(await h.request('/api/conversations/'+c.id)).data.conversation;
 assert.equal(c.document_body,doc.trim());assert.equal(c.busy,false);
 const id=(await h.request('/api/conversations/'+c.id+'/draft','POST',{revision:c.revision})).data.id;
 assert.equal((await h.request('/api/explorations/'+id,'GET',undefined,null)).status,404);
 assert.equal((await h.request('/api/explorations/'+id+'/branch','POST',{kind:'fork'},'bob')).status,404);
 assert.equal((await h.request('/api/explorations/'+id+'/publish','POST',{})).status,200);
 const article=(await h.request('/api/explorations/'+id,'GET',undefined,null)).data;
 assert.equal(article.exploration.document_body,doc.trim());assert.deepEqual(article.messages,transcript);
 assert.equal((await h.request('/api/explorations/'+id+'/branch','POST',{kind:'revision'},'bob')).status,403);
 const fork=(await h.request('/api/explorations/'+id+'/branch','POST',{kind:'rebuttal'},'bob')).data.conversation;
 assert.equal(fork.parent_exploration_id,id);assert.deepEqual(fork.base_messages,transcript);assert.equal(fork.messages.length,0);
 const revised=(await h.request('/api/conversations/'+fork.id,'PATCH',{revision:0,title:'다른 관점',document_body:'# 다른 관점\n\n원문에 반박한다.'},'bob')).data.conversation;
 const child=(await h.request('/api/conversations/'+fork.id+'/draft','POST',{revision:revised.revision},'bob')).data.id;
 assert(!(await h.request('/api/explorations/search?q=나무')).data.explorations.some((e:any)=>e.id===child));
 assert(!(await h.request('/api/explorations/'+id)).data.lineage.some((e:any)=>e.id===child));
 await h.request('/api/explorations/'+child+'/publish','POST',{},'bob');
 const tree=(await h.request('/api/explorations/search?q=나무','GET',undefined,null)).data.explorations;
 assert.equal(tree.find((e:any)=>e.id===child).parent_id,id);
 const inherited=(await h.request('/api/explorations/'+child,'GET',undefined,null)).data;
 assert.equal(inherited.exploration.relation_kind,'rebuttal');assert.equal(inherited.exploration.root_id,id);assert.deepEqual(inherited.messages,transcript);
 assert.equal((await h.request('/api/explorations/'+id)).data.exploration.document_body,doc.trim());
 const newEdit=(await h.request('/api/conversations/'+c.id,'PATCH',{revision:c.revision,document_body:'# 다음 버전\n수정'})).data.conversation;
 const revision=(await h.request('/api/conversations/'+c.id+'/draft','POST',{revision:newEdit.revision})).data.id;
 const version=(await h.request('/api/explorations/'+revision)).data.exploration;
 assert.equal(version.parent_id,id);assert.equal(version.relation_kind,'revision');assert.equal(version.version_number,2);
});

test('free point support conserves balances, rewards earlier supporters and rejects stale or duplicate spending',options,async t=>{
 const h=await harness(t),author=randomUUID(),charlie=randomUUID(),id=randomUUID(),other=randomUUID();
 await h.pool.query("INSERT INTO users(id,username) VALUES($1,'writer'),($2,'charlie')",[author,charlie]);
 await h.pool.query("INSERT INTO explorations(id,user_id,title,status) VALUES($1,$3,'Knowledge','published'),($2,$3,'Private','draft')",[id,other,author]);
 const svc=createSupport(h.pool);
 const path='/api/explorations/'+id+'/support';
 const amount=(percentage:number,balance:number)=>({request_id:randomUUID(),percentage,expected_balance:balance});
 assert.equal((await h.request('/api/support/wallet')).data.balance,1000);
 const p=amount(10,1000),first=await h.request(path,'POST',p);
 assert.equal(first.status,200);assert.equal(first.data.amount,100);assert.equal(first.data.author_received,100);assert.equal(first.data.prior_supporters_received,0);
 assert.deepEqual((await h.request(path,'POST',p)).data,first.data);
 assert.equal((await h.request('/api/support/wallet')).data.balance,900);
 assert.equal((await h.request(path,'POST',amount(10,1000))).status,409);
 const second=await h.request(path,'POST',amount(20,1000),'bob');
 assert.equal(second.data.amount,200);assert.equal(second.data.author_received,140);assert.equal(second.data.prior_supporters_received,60);
 assert.equal((await svc.wallet(author)).balance,1240);assert.equal((await svc.wallet(h.users.alice)).balance,960);
 const third=await svc.invest(charlie,id,amount(10,1000));
 assert.equal(third.author_received,70);assert.equal(third.prior_supporters_received,30);
 assert.equal((await svc.wallet(h.users.alice)).balance,970);assert.equal((await svc.wallet(h.users.bob)).balance,820);
 const repeat=await h.request(path,'POST',amount(10,970));
 assert.equal(repeat.data.amount,97);assert.equal(repeat.data.author_received,69);assert.equal(repeat.data.prior_supporters_received,28);
 assert.equal((await svc.wallet(h.users.alice)).balance,873); // no self-rebate
 await assert.rejects(svc.invest(author,id,amount(10,1000)),(e:any)=>e.code==='self_support');
 assert.equal((await h.request('/api/explorations/'+other+'/support','POST',amount(10,873))).status,404);
 assert.equal((await h.request(path,'POST',amount(10,873),null)).status,401);
 assert.equal((await h.request(path,'POST',amount(10,873),'alice',{origin:'https://attacker.invalid'})).status,403);
 assert.equal((await h.request(path,'POST',amount(101,873))).status,400);
 assert.equal((await h.request(path,'POST',{...amount(10,873),request_id:'-'.repeat(36)})).status,400);
 const race=await Promise.all([h.request(path,'POST',amount(10,873)),h.request(path,'POST',amount(10,873))]);
 assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
 const eventSums=(await h.pool.query('SELECT event_id,SUM(amount) AS n FROM point_ledger WHERE event_id IS NOT NULL GROUP BY event_id')).rows;
 assert(eventSums.every(r=>Number(r.n)===0));
 const balances=(await h.pool.query('SELECT w.balance,SUM(l.amount) AS ledger FROM point_wallets w JOIN point_ledger l USING(user_id) GROUP BY w.user_id,w.balance')).rows;
 assert(balances.every(r=>r.balance===r.ledger));assert.equal(balances.reduce((n,r)=>n+Number(r.balance),0),4000);
 assert.equal((await h.request(path,'GET',undefined,null)).data.total,584);
});

test('branching at a Q&A keeps only the prefix and the document available at that point',options,async t=>{
 const h=await harness(t);let c=(await h.request('/api/conversations','POST',{})).data.conversation;
 const send=async(message:string)=>{const r=await h.request('/api/chat','POST',{conversation_id:c.id,revision:c.revision,request_id:randomUUID(),message});assert.equal(r.status,200);c=r.data.conversation;};
 const edit=async(document_body:string)=>{c=(await h.request('/api/conversations/'+c.id,'PATCH',{revision:c.revision,document_body})).data.conversation;};
 await send('FIRST_QUESTION');await edit('# Early document\nEARLY_ONLY');
 await send('LATER_QUESTION');await edit('# Later document\nFUTURE_ONLY');
 const originalId=c.id,originalRevision=c.revision;
 const createBranch=(index:number,mode:string,revision=c.revision,user:'alice'|'bob'='alice')=>h.request('/api/conversations/'+originalId+'/branch','POST',{revision,message_index:index,mode,kind:'fork'},user);
 assert.equal((await createBranch(1,'continue',c.revision,'bob')).status,404);
 assert.equal((await createBranch(1,'continue',c.revision-1)).status,409);
 assert.equal((await createBranch(0,'continue')).status,400);
 assert.equal((await createBranch(1,'rewrite')).status,400);
 assert.equal((await createBranch(12,'continue')).status,400);
 const fromAnswer=await createBranch(1,'continue');assert.equal(fromAnswer.status,201);
 const branch=fromAnswer.data.conversation;
 assert.equal(branch.base_messages.length,2);assert.equal(branch.messages.length,0);assert.equal(branch.document_body,'# Early document\nEARLY_ONLY');
 assert.equal(branch.branch_anchor.message_index,1);assert.equal(branch.input_draft,'');
 const forkedReply=await h.request('/api/chat','POST',{conversation_id:branch.id,revision:0,request_id:randomUUID(),message:'FOLLOW_BRANCH'});
 assert.equal(forkedReply.status,200);const input=JSON.stringify(h.calls.at(-1)?.body);
 assert(input.includes('EARLY_ONLY'));assert(input.includes('FIRST_QUESTION'));assert(!input.includes('FUTURE_ONLY'));assert(!input.includes('LATER_QUESTION'));
 assert.deepEqual(forkedReply.data.injected_ids,[branch.parent_exploration_id]);
 const fromQuestion=(await createBranch(0,'rewrite')).data.conversation;
 assert.deepEqual(fromQuestion.base_messages,[]);assert.equal(fromQuestion.document_body,'');assert.equal(fromQuestion.input_draft,'FIRST_QUESTION');
 const changed=await h.request('/api/chat','POST',{conversation_id:fromQuestion.id,revision:0,request_id:randomUUID(),message:'REPLACEMENT_QUESTION'});
 assert.equal(changed.status,200);assert.equal(changed.data.conversation.input_draft,'');
 const replacedInput=JSON.stringify(h.calls.at(-1)?.body);assert(replacedInput.includes('REPLACEMENT_QUESTION'));assert(!replacedInput.includes('FIRST_QUESTION'));assert(!replacedInput.includes('FUTURE_ONLY'));
 const restored=(await h.request('/api/conversations/'+originalId)).data.conversation;
 assert.equal(restored.revision,originalRevision);assert.equal(restored.messages.length,4);assert.match(restored.document_body,/FUTURE_ONLY/);
 const compare=await h.request('/api/conversations/'+branch.id+'/compare');assert.equal(compare.status,200);
 assert.equal(compare.data.transcript.common,2);assert.equal(compare.data.transcript.removed.length,2);assert.equal(compare.data.transcript.added.length,2);
 assert(compare.data.document.rows.some((r:any)=>r.kind==='add'&&r.text==='EARLY_ONLY'));
 const version=(await h.request('/api/conversations/'+branch.id+'/draft','POST',{revision:forkedReply.data.conversation.revision})).data.id;
 const frozen=(await h.request('/api/explorations/'+version)).data;
 assert.equal(frozen.exploration.branch_anchor.message_index,1);assert.equal(frozen.messages[3].references[0].id,branch.parent_exploration_id);
 assert.equal((await h.request('/api/explorations/'+version+'/compare','GET',undefined,'bob')).status,404);
 await h.request('/api/explorations/'+version+'/publish','POST',{});
 const publicVersion=(await h.request('/api/explorations/'+version,'GET',undefined,null)).data;
 assert(!publicVersion.versions.some((e:any)=>e.id===branch.parent_exploration_id));
 assert.equal((await h.request('/api/explorations/'+version+'/compare?base='+branch.parent_exploration_id,'GET',undefined,null)).status,404);
 const publicFork=await h.request('/api/explorations/'+version+'/branch','POST',{message_index:1,mode:'continue',kind:'rebuttal'},'bob');
 assert.equal(publicFork.status,201);assert.equal(publicFork.data.conversation.base_messages.length,2);assert.equal(publicFork.data.conversation.document_body,'');
});

test('a saved knowledge document reaches the next model request and its source is retained with the answer',options,async t=>{
 const h=await harness(t),docId=randomUUID(),hidden=randomUUID();
 await h.pool.query("INSERT INTO explorations(id,user_id,slug,title,document_body,status) VALUES($1,$3,'reference','A reusable document',$4,'published'),($2,$3,'hidden','Secret',$5,'draft')",[docId,hidden,h.users.bob,'# Reference\nKNOWLEDGE_WHEEL_TOKEN_719','UNAUTHORIZED_SECRET']);
 const created=await h.request('/api/conversations','POST',{source_ids:[docId]});assert.equal(created.status,201);let c=created.data.conversation;
 assert.equal((await h.request('/api/conversations','POST',{source_ids:[hidden]})).status,404);
 const data={conversation_id:c.id,revision:c.revision,request_id:randomUUID(),message:'Use the reference document.'};
 const reply=await h.request('/api/chat','POST',data);assert.equal(reply.status,200);c=reply.data.conversation;
 assert(JSON.stringify(h.calls.at(-1)?.body).includes('KNOWLEDGE_WHEEL_TOKEN_719'));
 assert.deepEqual(reply.data.injected_ids,[docId]);assert.equal(c.messages[1].references[0].id,docId);
 const retry=await h.request('/api/chat','POST',data);assert.deepEqual(retry.data.injected_ids,[docId]);assert.equal(h.calls.length,1);
 const cleared=await h.request('/api/conversations/'+c.id,'PATCH',{revision:c.revision,source_ids:[]});c=cleared.data.conversation;
 const next=await h.request('/api/chat','POST',{...data,request_id:randomUUID(),revision:c.revision,message:'Now continue without that document.'});
 assert.equal(next.status,200);assert.deepEqual(next.data.injected_ids,[]);assert(!JSON.stringify(h.calls.at(-1)?.body).includes('KNOWLEDGE_WHEEL_TOKEN_719'));
 // Revalidate reference visibility on every model call, including document generation.
 c=next.data.conversation;c=(await h.request('/api/conversations/'+c.id,'PATCH',{revision:c.revision,source_ids:[docId]})).data.conversation;
 await h.pool.query("UPDATE explorations SET status='draft' WHERE id=$1",[docId]);
 const beforeCalls=h.calls.length;
 assert.equal((await h.request('/api/chat','POST',{conversation_id:c.id,revision:c.revision,request_id:randomUUID(),action:'document'})).status,404);
 assert.equal(h.calls.length,beforeCalls);
});
