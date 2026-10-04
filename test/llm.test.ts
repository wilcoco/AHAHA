import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  AppError, callProvider, decryptApiKey, encryptApiKey, hostedStatus, masterKeyConfigured,
  resolveProvider, validateApiKey, validateMessages, type ChatMessage,
} from "../src/llm.js";

const TEST_KEY = "sk-unitfixtureA79bCdEfGhIjKlMnOpQrStUvWxyz";
const MASTER = randomBytes(32);
const env = { BYOK_MASTER_KEY: MASTER.toString("base64") };
const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];
const none = { openai: false, anthropic: false };

function appError(code: string, status?: number) {
  return (error: unknown) => error instanceof AppError && error.code === code && (status === undefined || error.status === status);
}

function responseFetch(value: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

test("AES-GCM stores only authenticated ciphertext and fresh nonces", () => {
  const first = encryptApiKey(TEST_KEY, "user-a", "openai", env);
  const second = encryptApiKey(TEST_KEY, "user-a", "openai", env);
  assert.equal(decryptApiKey(first, "user-a", "openai", env), TEST_KEY);
  assert.equal(first.last4, TEST_KEY.slice(-4));
  assert.equal(Buffer.from(first.iv, "base64").length, 12);
  assert.equal(Buffer.from(first.tag, "base64").length, 16);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.ok(!JSON.stringify(first).includes(TEST_KEY));
  assert.notEqual(Buffer.from(first.ciphertext, "base64").toString(), TEST_KEY);
});

test("saved ciphertext is bound to both the account and provider", () => {
  const record = encryptApiKey(TEST_KEY, "user-a", "openai", env);
  assert.throws(() => decryptApiKey(record, "user-b", "openai", env), appError("byok_decryption_failed", 503));
  assert.throws(() => decryptApiKey(record, "user-a", "anthropic", env), appError("byok_decryption_failed", 503));
  assert.throws(() => decryptApiKey(record, "user-a", "openai", { BYOK_MASTER_KEY: randomBytes(32).toString("hex") }), appError("byok_decryption_failed"));
});

test("tampering with ciphertext, IV, tag, or encoding is rejected without plaintext", () => {
  const record = encryptApiKey(TEST_KEY, "user-a", "anthropic", env);
  for (const field of ["ciphertext", "iv", "tag"] as const) {
    const bytes = Buffer.from(record[field], "base64");
    bytes[0] ^= 1;
    assert.throws(() => decryptApiKey({ ...record, [field]: bytes.toString("base64") }, "user-a", "anthropic", env), appError("byok_decryption_failed"));
    assert.throws(() => decryptApiKey({ ...record, [field]: "not base64" }, "user-a", "anthropic", env), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.ok(!error.message.includes(TEST_KEY));
      return error.code === "byok_decryption_failed";
    });
  }
});

test("master key supports exactly 32 random bytes as hex or base64", () => {
  for (const encoded of [MASTER.toString("hex"), MASTER.toString("base64"), MASTER.toString("base64").replace(/=$/, "")]) {
    const keyEnv = { BYOK_MASTER_KEY: encoded };
    assert.ok(masterKeyConfigured(keyEnv));
    const record = encryptApiKey(TEST_KEY, "user-a", "openai", keyEnv);
    assert.equal(decryptApiKey(record, "user-a", "openai", keyEnv), TEST_KEY);
  }
  for (const invalid of [undefined, "", "replace-with-a-random-32-byte-key", "not-configured", "a".repeat(64), randomBytes(24).toString("base64"), randomBytes(48).toString("hex"), "!".repeat(43)]) {
    assert.equal(masterKeyConfigured({ BYOK_MASTER_KEY: invalid }), false);
    assert.throws(() => encryptApiKey(TEST_KEY, "user-a", "openai", { BYOK_MASTER_KEY: invalid }), appError("byok_not_configured"));
  }
});

test("API keys reject missing values, placeholders and header injection", () => {
  assert.equal(validateApiKey(`  ${TEST_KEY}  `), TEST_KEY);
  for (const value of [undefined, null, 1234, "", "short", "not-configured", "sk-your_openai_api_key_here", "replace-with-your-anthropic-api-key", "x".repeat(64), "sk-example-aaaaaaaaaaaaaaaaaaaa", `${TEST_KEY}\r\nX-Injected: bad`, `${TEST_KEY} bad`, "a".repeat(513)]) {
    assert.throws(() => validateApiKey(value), appError("invalid_api_key", 400));
  }
});

test("hosted status exposes presence and model names only", () => {
  const status = hostedStatus({ HOSTED_OPENAI_API_KEY: TEST_KEY, HOSTED_ANTHROPIC_API_KEY: "not-configured", HOSTED_OPENAI_MODEL: "gpt-4.1" });
  assert.deepEqual(status, { openai: { configured: true, model: "gpt-4.1" }, anthropic: { configured: false, model: "claude-haiku-4-5-20251001" } });
  assert.ok(!JSON.stringify(status).includes(TEST_KEY));
  assert.equal(hostedStatus({ HOSTED_OPENAI_MODEL: "bad\nmodel" }).openai.model, "gpt-4.1-mini");
});

test("auto provider order favors hosted then available personal providers", () => {
  const both = { openai: true, anthropic: true };
  assert.equal(resolveProvider("auto", both, { ...env, HOSTED_OPENAI_API_KEY: TEST_KEY, HOSTED_ANTHROPIC_API_KEY: TEST_KEY }), "hosted_openai");
  assert.equal(resolveProvider("auto", both, { ...env, HOSTED_ANTHROPIC_API_KEY: TEST_KEY }), "hosted_anthropic");
  assert.equal(resolveProvider("auto", both, env), "byok_openai");
  assert.equal(resolveProvider("auto", { openai: false, anthropic: true }, env), "byok_anthropic");
  assert.throws(() => resolveProvider("auto", none, env), appError("no_provider_available", 503));
  assert.throws(() => resolveProvider("auto", both, {}), appError("no_provider_available"));
});

test("explicit selection never silently switches billing sources", () => {
  assert.equal(resolveProvider("byok_anthropic", { openai: true, anthropic: true }, { ...env, HOSTED_OPENAI_API_KEY: TEST_KEY }), "byok_anthropic");
  assert.throws(() => resolveProvider("byok_openai", none, { ...env, HOSTED_OPENAI_API_KEY: TEST_KEY }), appError("provider_not_configured"));
  assert.throws(() => resolveProvider("hosted_anthropic", { openai: true, anthropic: true }, env), appError("provider_not_configured"));
  for (const selection of ["unknown", "toString", {}, null, undefined]) assert.throws(() => resolveProvider(selection, none, {}), appError("invalid_provider", 400));
});

test("message validation preserves text while bounding roles, order and size", () => {
  const valid: ChatMessage[] = [{ role: "system", content: "Be concise" }, { role: "user", content: "Question" }, { role: "assistant", content: "Answer" }, { role: "user", content: "  More\nplease  " }];
  assert.deepEqual(validateMessages(valid), valid);
  for (const value of [null, [], "Hello", [{ role: "tool", content: "x" }], [{ role: "user", content: " " }], [{ role: "user", content: {} }], [{ role: "user", content: "x".repeat(16001) }], [{ role: "assistant", content: "x" }, ...messages], [...messages, { role: "system", content: "x" }, ...messages], [...messages, { role: "assistant", content: "x" }], [{ role: "system", content: "x" }], Array.from({ length: 101 }, () => messages[0])]) {
    assert.throws(() => validateMessages(value), appError("invalid_messages", 400));
  }
  assert.throws(() => validateMessages(Array.from({ length: 5 }, () => ({ role: "user", content: "x".repeat(16000) }))), appError("messages_too_large", 400));
});

test("OpenAI uses Responses with stateless messages and bounded output", async () => {
  const history: ChatMessage[] = [{ role: "system", content: "Be concise" }, ...messages];
  const fake = (async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TEST_KEY}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "gpt-4.1-mini", input: history, store: false, max_output_tokens: 2048 });
    return new Response(JSON.stringify({ output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }, { type: "output_text", text: " there" }] }] }));
  }) as typeof fetch;
  assert.deepEqual(await callProvider("hosted_openai", history, undefined, { HOSTED_OPENAI_API_KEY: TEST_KEY }, fake), { provider: "hosted_openai", model: "gpt-4.1-mini", content: "Hello there" });
});

test("Anthropic separates system messages and sends required authentication/version", async () => {
  const history: ChatMessage[] = [{ role: "system", content: "Be concise" }, { role: "system", content: "Use Korean" }, ...messages];
  const fake = (async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), TEST_KEY);
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(headers.get("authorization"), null);
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "claude-haiku-4-5-20251001", system: "Be concise\n\nUse Korean", messages, max_tokens: 2048 });
    return new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "안녕하세요" }] }));
  }) as typeof fetch;
  assert.deepEqual(await callProvider("byok_anthropic", history, TEST_KEY, {}, fake), { provider: "byok_anthropic", model: "claude-haiku-4-5-20251001", content: "안녕하세요" });
});

test("BYOK honors model configuration and requires the supplied personal key", async () => {
  const fake = (async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).model, "gpt-4.1");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TEST_KEY}`);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }));
  }) as typeof fetch;
  assert.equal((await callProvider("byok_openai", messages, TEST_KEY, { HOSTED_OPENAI_MODEL: "gpt-4.1" }, fake)).model, "gpt-4.1");
  await assert.rejects(callProvider("byok_openai", messages, undefined, { HOSTED_OPENAI_API_KEY: TEST_KEY }, fake), appError("provider_not_configured"));
});

test("upstream authentication, quota and service failures never expose response bodies", async () => {
  for (const [status, code, outputStatus] of [[401, "provider_auth_failed", 502], [403, "provider_auth_failed", 502], [429, "provider_rate_limited", 429], [500, "provider_request_failed", 502], [400, "provider_request_failed", 502]] as const) {
    await assert.rejects(callProvider("byok_openai", messages, TEST_KEY, {}, responseFetch({ error: { message: `Leaked ${TEST_KEY} and user prompt` } }, status)), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, code);
      assert.equal(error.status, outputStatus);
      assert.ok(!String(error).includes(TEST_KEY));
      assert.ok(!String(error).includes("user prompt"));
      return true;
    });
  }
});

test("network failures are replaced with a safe generic error", async () => {
  const fake = (async () => { throw new Error(`Header contains ${TEST_KEY}`); }) as typeof fetch;
  await assert.rejects(callProvider("byok_anthropic", messages, TEST_KEY, {}, fake), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "provider_unavailable");
    assert.ok(!error.message.includes(TEST_KEY));
    return true;
  });
});

test("empty, malformed and oversized responses fail safely", async () => {
  await assert.rejects(callProvider("byok_openai", messages, TEST_KEY, {}, responseFetch({ output: [] })), appError("empty_provider_response"));
  await assert.rejects(callProvider("byok_anthropic", messages, TEST_KEY, {}, (async () => new Response("not json")) as typeof fetch), appError("invalid_provider_response"));
  await assert.rejects(callProvider("byok_openai", messages, TEST_KEY, {}, (async () => new Response("x".repeat(1_048_577))) as typeof fetch), appError("invalid_provider_response"));
});

test("OpenAI refusals are returned as displayable assistant text", async () => {
  const result = await callProvider("byok_openai", messages, TEST_KEY, {}, responseFetch({ output: [{ type: "message", content: [{ type: "refusal", refusal: "I cannot help with that request." }] }] }));
  assert.equal(result.content, "I cannot help with that request.");
});

test("provider calls are aborted after the timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = (async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as typeof fetch;
  const result = callProvider("byok_openai", messages, TEST_KEY, {}, fake);
  t.mock.timers.tick(45_000);
  await assert.rejects(result, appError("provider_timeout", 504));
});
