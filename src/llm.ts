import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type Provider = "openai" | "anthropic";
export type ChatProvider = "auto" | "hosted_openai" | "hosted_anthropic" | "byok_openai" | "byok_anthropic";
export type ResolvedChatProvider = Exclude<ChatProvider, "auto">;
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type EncryptedApiKey = { ciphertext: string; iv: string; tag: string; last4: string };
type Env = Record<string, string | undefined>;

const DEFAULT_MODELS = { openai: "gpt-4.1-mini", anthropic: "claude-haiku-4-5-20251001" };
const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_TOTAL_CHARS = 64_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 2_048;
const VALID_PROVIDERS: ResolvedChatProvider[] = ["hosted_openai", "hosted_anthropic", "byok_openai", "byok_anthropic"];

export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "AppError";
  }
}

function isPlaceholder(value: string): boolean {
  return /(?:placeholder|replace[_-]?(?:me|with)|change[_-]?me|your[_-]?(?:(?:openai|anthropic)[_-])?(?:api[_-]?)?key|not[_-]?(?:configured|set)|insert[_-]?(?:api[_-]?)?key|^unset$|^todo$|^sk-(?:test|example)(?:-|$)|^x+$|^0+$)/i.test(value);
}

export function validateApiKey(value: unknown): string {
  if (typeof value !== "string") throw new AppError(400, "invalid_api_key", "Enter a valid API key.");
  const key = value.trim();
  // Reject control characters and placeholders before they reach headers or storage.
  if (!/^[\x21-\x7e]{20,512}$/.test(key) || isPlaceholder(key)) {
    throw new AppError(400, "invalid_api_key", "Enter a valid API key, not a placeholder.");
  }
  return key;
}

function configuredApiKey(value: unknown): boolean {
  try { validateApiKey(value); return true; } catch { return false; }
}

function modelFor(provider: Provider, env: Env): string {
  const value = env[provider === "openai" ? "HOSTED_OPENAI_MODEL" : "HOSTED_ANTHROPIC_MODEL"]?.trim();
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !isPlaceholder(value)
    ? value : DEFAULT_MODELS[provider];
}

export function hostedStatus(env: Env = process.env) {
  return {
    openai: { configured: configuredApiKey(env.HOSTED_OPENAI_API_KEY), model: modelFor("openai", env) },
    anthropic: { configured: configuredApiKey(env.HOSTED_ANTHROPIC_API_KEY), model: modelFor("anthropic", env) },
  };
}

function masterKey(env: Env): Buffer {
  const value = env.BYOK_MASTER_KEY?.trim() || "";
  let key: Buffer | undefined;
  if (/^[a-f\d]{64}$/i.test(value)) key = Buffer.from(value, "hex");
  else if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64").replace(/=$/, "") === value.replace(/=$/, "")) key = decoded;
  }
  // A repeated-byte dummy value is a common setup placeholder, not a generated key.
  if (!key || key.length !== 32 || key.every(byte => byte === key![0])) {
    throw new AppError(503, "byok_not_configured", "BYOK is unavailable until a valid BYOK_MASTER_KEY is configured.");
  }
  return key;
}

export function masterKeyConfigured(env: Env = process.env): boolean {
  try { const key = masterKey(env); key.fill(0); return true; } catch { return false; }
}

function associatedData(userId: string, provider: Provider): Buffer {
  if (!userId || (provider !== "openai" && provider !== "anthropic")) {
    throw new AppError(400, "invalid_key_owner", "A valid account and provider are required.");
  }
  // Versioned, unambiguous binding prevents ciphertext being moved between users/providers.
  return Buffer.from(JSON.stringify(["exploration-byok-v1", userId, provider]), "utf8");
}

export function encryptApiKey(apiKey: unknown, userId: string, provider: Provider, env: Env = process.env): EncryptedApiKey {
  const value = validateApiKey(apiKey);
  const key = masterKey(env);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(associatedData(userId, provider));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), last4: value.slice(-4) };
  } finally {
    key.fill(0);
  }
}

function decodeBase64(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 1024) throw new Error("Invalid encrypted record");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) throw new Error("Invalid encrypted record");
  return decoded;
}

export function decryptApiKey(record: Pick<EncryptedApiKey, "ciphertext" | "iv" | "tag">, userId: string, provider: Provider, env: Env = process.env): string {
  const key = masterKey(env);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, decodeBase64(record.iv, 12));
    decipher.setAAD(associatedData(userId, provider));
    decipher.setAuthTag(decodeBase64(record.tag, 16));
    const plaintext = Buffer.concat([decipher.update(decodeBase64(record.ciphertext)), decipher.final()]);
    try { return validateApiKey(plaintext.toString("utf8")); } finally { plaintext.fill(0); }
  } catch {
    throw new AppError(503, "byok_decryption_failed", "The saved key cannot be read. Replace it in Settings or contact the administrator.");
  } finally {
    key.fill(0);
  }
}

export function validateMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_MESSAGES) {
    throw new AppError(400, "invalid_messages", "Send between 1 and 100 conversation messages.");
  }
  let total = 0;
  let conversationStarted = false;
  const result = value.map((message: unknown): ChatMessage => {
    if (!message || typeof message !== "object") throw new AppError(400, "invalid_messages", "Each message needs a role and text content.");
    const { role, content } = message as Record<string, unknown>;
    if ((role !== "system" && role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim() || content.length > MAX_MESSAGE_CHARS) {
      throw new AppError(400, "invalid_messages", "Use system, user, or assistant messages with 1 to 16000 characters of text each.");
    }
    if ((role === "system" && conversationStarted) || (role === "assistant" && !conversationStarted)) {
      throw new AppError(400, "invalid_messages", "Place system messages first and start the conversation with a user message.");
    }
    if (role === "user") conversationStarted = true;
    total += content.length;
    if (total > MAX_TOTAL_CHARS) throw new AppError(400, "messages_too_large", "Keep the conversation within 64000 characters.");
    return { role, content };
  });
  if (result[result.length - 1].role !== "user") throw new AppError(400, "invalid_messages", "The conversation must end with a user message.");
  return result;
}

export function resolveProvider(selection: unknown, byokAvailable: Record<Provider, boolean>, env: Env = process.env): ResolvedChatProvider {
  const hosted = hostedStatus(env);
  const byokEnabled = masterKeyConfigured(env);
  const available: Record<ResolvedChatProvider, boolean> = {
    hosted_openai: hosted.openai.configured,
    hosted_anthropic: hosted.anthropic.configured,
    byok_openai: byokEnabled && byokAvailable.openai,
    byok_anthropic: byokEnabled && byokAvailable.anthropic,
  };
  if (selection === "auto") {
    const provider = VALID_PROVIDERS.find(item => available[item]);
    if (provider) return provider;
    throw new AppError(503, "no_provider_available", "No chat provider is configured. Add a key in Settings or configure a hosted provider.");
  }
  if (typeof selection !== "string" || !VALID_PROVIDERS.includes(selection as ResolvedChatProvider)) {
    throw new AppError(400, "invalid_provider", "Choose a supported chat provider.");
  }
  const provider = selection as ResolvedChatProvider;
  if (!available[provider]) {
    throw new AppError(503, "provider_not_configured", provider.startsWith("byok_")
      ? "This personal provider is unavailable. Save its API key in Settings and ensure BYOK is enabled."
      : "This hosted provider is not configured. Choose another provider or add your own key in Settings.");
  }
  return provider;
}

function upstreamError(status: number): AppError {
  if (status === 401 || status === 403) return new AppError(502, "provider_auth_failed", "The provider rejected the API key or account permissions. Check the configured key.");
  if (status === 429) return new AppError(429, "provider_rate_limited", "The provider's rate limit or quota was reached. Check billing or try again later.");
  return new AppError(502, "provider_request_failed", "The provider could not complete the request. Check the model configuration or try again later.");
}

async function readResponseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new AppError(502, "invalid_provider_response", "The provider returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError(502, "invalid_provider_response", "The provider returned an oversized response.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError(502, "invalid_provider_response", "The provider returned an invalid response. Please try again."); }
}

export async function callProvider(
  provider: ResolvedChatProvider,
  messages: ChatMessage[],
  apiKey: string | undefined,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ provider: ResolvedChatProvider; model: string; content: string }> {
  if (!VALID_PROVIDERS.includes(provider)) throw new AppError(400, "invalid_provider", "Choose a supported chat provider.");
  const validated = validateMessages(messages);
  const vendor: Provider = provider.endsWith("openai") ? "openai" : "anthropic";
  const model = modelFor(vendor, env);
  let key: string;
  try {
    key = validateApiKey(apiKey ?? (provider.startsWith("hosted_") ? env[vendor === "openai" ? "HOSTED_OPENAI_API_KEY" : "HOSTED_ANTHROPIC_API_KEY"] : undefined));
  } catch {
    throw new AppError(503, "provider_not_configured", "This provider has no valid API key configured.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref();
  try {
    const payload = vendor === "openai"
      ? { model, input: validated, store: false, max_output_tokens: MAX_OUTPUT_TOKENS }
      : {
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...(validated.some(message => message.role === "system") ? { system: validated.filter(message => message.role === "system").map(message => message.content).join("\n\n") } : {}),
          messages: validated.filter(message => message.role !== "system"),
        };
    const response = await fetchImpl(vendor === "openai" ? "https://api.openai.com/v1/responses" : "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: vendor === "openai"
        ? { "content-type": "application/json", authorization: `Bearer ${key}` }
        : { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      // Never follow an upstream redirect with credentials.
      redirect: "error",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw upstreamError(response.status);
    }
    const data = await readResponseJson(response) as Record<string, unknown> | null;
    let content = "";
    if (vendor === "openai" && Array.isArray(data?.output)) {
      content = data.output.flatMap((item: any) => item?.type === "message" && Array.isArray(item.content) ? item.content : [])
        .map((part: any) => part?.type === "output_text" && typeof part.text === "string" ? part.text : part?.type === "refusal" && typeof part.refusal === "string" ? part.refusal : "").join("");
    } else if (vendor === "anthropic" && Array.isArray(data?.content)) {
      content = data.content.map((part: any) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("");
    }
    if (!content.trim()) throw new AppError(502, "empty_provider_response", "The provider returned no text. Please try again.");
    return { provider, model, content };
  } catch (error) {
    if (controller.signal.aborted) throw new AppError(504, "provider_timeout", "The provider took too long to respond. Please try again.");
    if (error instanceof AppError) throw error;
    // Native fetch errors and upstream response bodies may contain credentials or prompts.
    throw new AppError(502, "provider_unavailable", "The provider is temporarily unavailable. Please try again.");
  } finally {
    clearTimeout(timeout);
  }
}
