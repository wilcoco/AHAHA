import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AppError, callProvider, decryptApiKey, encryptApiKey, hostedStatus,
  masterKeyConfigured, resolveProvider, validateApiKey, validateMessages,
  type ChatProvider, type Provider
} from "./llm.js";

import type { createWorkspace } from "./workspace.js";

type Query = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
const selections: ChatProvider[] = ["auto", "hosted_openai", "hosted_anthropic", "byok_openai", "byok_anthropic"];

export async function initChatDb(q: Query) {
  await q(`
    CREATE TABLE IF NOT EXISTS user_llm_keys (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider text NOT NULL CHECK (provider IN ('openai','anthropic')),
      ciphertext text NOT NULL,
      iv text NOT NULL,
      tag text NOT NULL,
      last4 varchar(4) NOT NULL,
      encryption_version smallint NOT NULL DEFAULT 1 CHECK (encryption_version = 1),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS user_llm_settings (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      provider text NOT NULL DEFAULT 'auto'
        CHECK (provider IN ('auto','hosted_openai','hosted_anthropic','byok_openai','byok_anthropic'))
    );
    CREATE TABLE IF NOT EXISTS user_chat_rate_limits (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      window_start timestamptz NOT NULL,
      requests integer NOT NULL
    );
  `);
}

export function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(data));
}

function selection(value: unknown): ChatProvider {
  if (typeof value !== "string" || !selections.includes(value as ChatProvider)) {
    throw new AppError(400, "invalid_provider", "Choose a supported provider.");
  }
  return value as ChatProvider;
}

export function requireSameOrigin(req: IncomingMessage, origin: string) {
  if (req.headers.origin !== new URL(origin).origin || req.headers["sec-fetch-site"] === "cross-site") {
    throw new AppError(403, "invalid_origin", "Please submit this request from Exploration.");
  }
}

export async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AppError(415, "json_required", "Send an application/json request.");
  }
  // Discard over-limit chunks rather than retaining key material or logging bodies.
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        if (!exceeded) reject(new AppError(413, "request_too_large", "The request is too large."));
        exceeded = true;
      } else if (!exceeded) chunks.push(chunk);
    });
    req.on("end", () => { if (!exceeded) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", () => reject(new AppError(400, "invalid_request", "Could not read the request.")));
    req.on("aborted", () => reject(new AppError(400, "invalid_request", "The request was interrupted.")));
  });
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new AppError(400, "invalid_json", "Send a valid JSON object.");
  }
}

export function createChatApi({ q, authenticate, env = process.env, fetchImpl = fetch, workspace }: {
  q: Query;
  workspace?: ReturnType<typeof createWorkspace>;
  authenticate: (req: IncomingMessage) => Promise<{ id: string } | null>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}) {
  const active = new Set<string>();
  async function settings(userId: string) {
    const keys = (await q("SELECT provider,last4 FROM user_llm_keys WHERE user_id=$1", [userId])).rows;
    const preference = (await q("SELECT provider FROM user_llm_settings WHERE user_id=$1", [userId])).rows[0];
    const keyStatus = (provider: Provider) => {
      const key = keys.find(row => row.provider === provider);
      return { configured: !!key, last4: key?.last4 || null };
    };
    return {
      hosted: hostedStatus(env),
      byok: { enabled: masterKeyConfigured(env), openai: keyStatus("openai"), anthropic: keyStatus("anthropic") },
      provider: preference?.provider || "auto"
    };
  }

  return async function handleChatApi(req: IncomingMessage, res: ServerResponse, pathname: string, origin: string) {
    const isWorkspace = pathname.startsWith("/api/conversations") || pathname.startsWith("/api/explorations/") || pathname.startsWith("/api/support/");
    if (pathname !== "/api/chat" && !pathname.startsWith("/api/llm/") && !isWorkspace) return false;
    try {
      // Web sessions only: MCP/OAuth credentials never authorize spending or managing LLM keys.
      const user = await authenticate(req);
      if(!user&&isWorkspace&&req.method==='GET'&&pathname.startsWith('/api/explorations/')&&workspace){await workspace.api(req,res,new URL(req.url!,origin),null,origin);return true;}
      if (!user) throw new AppError(401, "sign_in_required", "Sign in to Exploration to continue.");
      if (req.method !== "GET") requireSameOrigin(req, origin);

      if (isWorkspace) {
        if (!workspace) throw new AppError(404, "not_found", "Workspace unavailable.");
        await workspace.api(req,res,new URL(req.url!,origin),user.id,origin);
        return true;
      }

      if (pathname === "/api/llm/settings" && req.method === "GET") {
        json(res, 200, await settings(user.id));
      } else if (pathname === "/api/llm/settings" && req.method === "PUT") {
        const data = await readJson(req, 1024);
        const provider = selection(data.provider);
        await q(`INSERT INTO user_llm_settings(user_id,provider) VALUES($1,$2)
          ON CONFLICT(user_id) DO UPDATE SET provider=EXCLUDED.provider`, [user.id, provider]);
        json(res, 200, { provider });
      } else if (/^\/api\/llm\/keys\/(openai|anthropic)$/.test(pathname) && ["PUT", "DELETE"].includes(req.method || "")) {
        const provider = pathname.split("/").at(-1) as Provider;
        if (req.method === "DELETE") {
          // Deletion is always possible, even if the encryption master key is unavailable.
          await q("DELETE FROM user_llm_keys WHERE user_id=$1 AND provider=$2", [user.id, provider]);
          json(res, 200, { provider, configured: false, last4: null });
        } else {
          const data = await readJson(req, 4096);
          const record = encryptApiKey(validateApiKey(data.apiKey), user.id, provider, env);
          await q(`INSERT INTO user_llm_keys(user_id,provider,ciphertext,iv,tag,last4) VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT(user_id,provider) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,
              iv=EXCLUDED.iv,tag=EXCLUDED.tag,last4=EXCLUDED.last4,updated_at=now()`,
          [user.id, provider, record.ciphertext, record.iv, record.tag, record.last4]);
          json(res, 200, { provider, configured: true, last4: record.last4 });
        }
      } else if (pathname === "/api/chat" && req.method === "POST") {
        const data = await readJson(req, 300000);
        const prepared = data.conversation_id !== undefined && workspace ? await workspace.prepare(user.id,data) : null;
        if (prepared?.cached) {
          json(res,200,{conversation:workspace!.publicConversation(prepared.row),provider:prepared.row.provider,model:prepared.row.model,message:prepared.row.messages.at(-1),injected_ids:prepared.row.messages.at(-1)?.references?.map((r:any)=>r.id)||[]});
          return true;
        }
        const messages = validateMessages(prepared ? prepared.messages : data.messages);
        const current = await settings(user.id);
        const requested = data.provider === undefined ? current.provider : selection(data.provider);
        const provider = resolveProvider(requested, {
          openai: current.byok.enabled && current.byok.openai.configured,
          anthropic: current.byok.enabled && current.byok.anthropic.configured
        }, env);
        if (active.has(user.id)) throw new AppError(429, "chat_in_progress", "Wait for your current response to finish.");
        active.add(user.id);
        let locked = false;
        try {
          if (prepared) { await workspace!.begin(user.id,prepared); locked = true; }
          const allowed = await q(`INSERT INTO user_chat_rate_limits(user_id,window_start,requests)
            VALUES($1,date_trunc('minute',now()),1)
            ON CONFLICT(user_id) DO UPDATE SET window_start=EXCLUDED.window_start,
              requests=CASE WHEN user_chat_rate_limits.window_start=EXCLUDED.window_start
                THEN user_chat_rate_limits.requests+1 ELSE 1 END
            WHERE user_chat_rate_limits.window_start<>EXCLUDED.window_start OR user_chat_rate_limits.requests<20
            RETURNING requests`, [user.id]);
          if (!allowed.rowCount) throw new AppError(429, "rate_limited", "Chat limit reached. Try again in a minute.");
          const vendor: Provider = provider.endsWith("openai") ? "openai" : "anthropic";
          let apiKey: string;
          if (provider.startsWith("byok_")) {
            const record = (await q("SELECT ciphertext,iv,tag,last4 FROM user_llm_keys WHERE user_id=$1 AND provider=$2", [user.id, vendor])).rows[0];
            if (!record) throw new AppError(409, "key_missing", "Save your API key in Settings first.");
            apiKey = decryptApiKey(record, user.id, vendor, env);
          } else {
            apiKey = (vendor === "openai" ? env.HOSTED_OPENAI_API_KEY : env.HOSTED_ANTHROPIC_API_KEY)!.trim();
          }
          const result = await callProvider(provider, messages, apiKey, env, fetchImpl);
          const conversation = prepared ? await workspace!.finish(user.id,prepared,result) : undefined;
          locked = false;
          json(res, 200, { provider: result.provider, model: result.model, message: { role: "assistant", content: result.content }, ...(conversation ? {conversation,injected_ids:prepared?.injected?.map((r:any)=>r.id)||[]} : {}) });
        } finally {
          active.delete(user.id);
          if (locked && prepared) await workspace!.release(user.id,prepared);
        }
      } else {
        throw new AppError(404, "not_found", "API route not found.");
      }
    } catch (error) {
      // Never forward raw DB/upstream errors: they can contain request bodies or credentials.
      const safe = error instanceof AppError ? error : new AppError(500, "internal_error", "Unable to complete the request. Please try again.");
      json(res, safe.status, { error: { code: safe.code, message: safe.message } });
    }
    return true;
  };
}
