import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test, { type TestContext } from "node:test";
import pg from "pg";
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
  await pool.query("CREATE TABLE users(id uuid PRIMARY KEY)");
  const users = { alice: randomUUID(), bob: randomUUID() };
  await pool.query("INSERT INTO users(id) VALUES($1),($2)", [users.alice, users.bob]);
  const q = (sql: string, params: any[] = []) => pool.query(sql, params);
  await initChatDb(q);
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
