# Exploration MVP

A personal knowledge blog co-created with AI: discover topics, develop ideas in conversation, and keep the resulting documents and their version history together.

**Live web:** https://exploration-web-production.up.railway.app  
**Claude connect page:** https://exploration-web-production.up.railway.app/connect/claude  
**Remote MCP:** https://exploration-web-production.up.railway.app/mcp  
**Repository:** wilcoco/AHAHA (temporary repository name for this MVP)

Users can chat in Exploration with a service-provided OpenAI or Anthropic model (Hosted LLM), or save their own provider API key (BYOK). They can also keep using Claude, ChatGPT, Cursor, Codex, or another MCP-capable client through the existing Remote MCP connection. Exploration stores private drafts, publishes selected explorations, preserves optional source messages, and keeps a creator identity across AI providers.

## Core object

A published **Exploration** pairs an editable Markdown document with the conversation that produced it. It has a topic, author, parent, root, relation (`original`, `revision`, `fork`, or `rebuttal`), and version number. Older MCP explorations still display their question, starting view, key turns, turning points, and current view as a document.

Conversations and working documents are private. Saving a version creates a snapshot of the document and transcript; publishing is an explicit separate action. A fork or rebuttal belongs to its new author and preserves the original source. Published versions are not silently updated by later workspace edits.

## Routes

- `/` public feed
- `/@username` public knowledge blog, grouped by topic
- `/blog` signed-in personal blog: published/private versions, working conversations, and points
- `/@username/:slug` published exploration
- `/me` creator account / private list / Hosted provider status / BYOK settings
- `/chat` three-panel workspace: topic-grouped document library, paired conversation, editable result document (public reading works without sign-in)
- `POST /api/chat` send conversation messages to the selected provider
- `GET /api/llm/settings` read provider preference and safe configuration status
- `PUT /api/llm/settings` save provider preference
- `PUT /api/llm/keys/openai` and `PUT /api/llm/keys/anthropic` save or replace the signed-in user's API key
- `DELETE /api/llm/keys/openai` and `DELETE /api/llm/keys/anthropic` remove the signed-in user's API key
- `/connect/claude` Claude onboarding
- `/mcp` Remote MCP endpoint
- `/health` Railway health check
- `/.well-known/oauth-protected-resource` MCP protected-resource metadata
- `/.well-known/oauth-authorization-server` OAuth authorization-server metadata
- `/oauth/register` Dynamic Client Registration compatibility endpoint
- `/oauth/authorize` user sign-in / consent
- `/oauth/token` authorization-code + PKCE and refresh-token exchange
- `/oauth/revoke` token revocation

## MCP tools

- `create_exploration` — private draft by default
- `append_exploration`
- `publish_exploration` — only after explicit user intent
- `get_exploration`
- `list_my_explorations`
- `search_my_explorations`
- `search_public_explorations`
- `get_creator_context`

## Authentication

The public connection path is OAuth 2.1-style Authorization Code + PKCE.

The MCP endpoint returns a 401 challenge with Protected Resource Metadata when no valid token is present. An MCP host can discover the authorization server, register a client if needed, open the user authorization page, exchange the authorization code for an access token, and refresh it later.

Access tokens are short-lived (1 hour). Refresh tokens expire after 30 days and are rotated on refresh.

Passwords are hashed with Node.js `scrypt`. OAuth and web-session tokens are stored as SHA-256 hashes, not plaintext.

The original `exp_...` bearer-token mechanism remains server-side only for backward compatibility with early MVP sessions; it is no longer exposed in the UI.

Chat and LLM settings APIs require the `exploration_web` browser session created by website sign-in. MCP OAuth access tokens and legacy bearer tokens do not authorize these APIs. Existing Remote MCP/OAuth routes and Exploration tools remain available separately.

## Hosted LLM and BYOK

Sign in at `/me` to see **OpenAI hosted configured / not configured** and **Anthropic hosted configured / not configured**. These indicators describe server configuration; an actual chat request checks whether the provider accepts the key and model. Empty values and placeholders do not enable a Hosted provider.

The account page also lets each user save, replace, or delete their own OpenAI and Anthropic API keys and select a default chat provider. Saved keys are never returned to the browser: the UI shows only whether a key is saved and its last four characters. BYOK keys are encrypted before storage in PostgreSQL with AES-256-GCM, using a fresh nonce and authenticated data bound to the user and provider. `BYOK_MASTER_KEY` supplies the encryption key. If it is missing, a placeholder, or invalid, BYOK storage and use are disabled; Hosted chat and existing Exploration features can still operate.

Available provider values:

| Provider | Credentials used |
| --- | --- |
| `hosted_openai` | Service's `HOSTED_OPENAI_API_KEY` |
| `hosted_anthropic` | Service's `HOSTED_ANTHROPIC_API_KEY` |
| `byok_openai` | Signed-in user's encrypted OpenAI key |
| `byok_anthropic` | Signed-in user's encrypted Anthropic key |
| `auto` | First configured provider in the order below |

`auto` chooses `hosted_openai`, then `hosted_anthropic`, then `byok_openai`, then `byok_anthropic`. If none is configured, the app explains that a provider must be configured before sending a message. Selection is based on configuration, not a promise that an upstream key has valid billing or model access.

Open `/chat`, choose a provider, and send a message. The workspace sends a conversation ID, revision, request ID, new message, and selected reference IDs to `POST /api/chat`. The server loads the account-owned history and calls [OpenAI's Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create) or [Anthropic's Messages API](https://platform.claude.com/docs/en/api/messages/create) and returns the assistant response. API keys remain on the server after saving.

Conversations are stored privately in PostgreSQL after each successful reply. The left panel is a topic-grouped document library, initially showing your own blog when signed in. It works without a search term; switch to the public blog to discover other authors. It shows visible revisions, forks, and rebuttals as child nodes. Clicking a result opens the original conversation in the center and its document on the right. Search is keyword search of stored articles, not live web search. Private branches are visible only to their owner.

The center continues a private working conversation. Fork/rebuttal copies the source document and transcript into a new private conversation with attribution to its parent. Authors can also start a revision. The inherited transcript is collapsible; the original stays intact.

The right panel shows a real Markdown document. By default, a successful conversation reply is followed by a separate AI document-generation request through the selected provider. This uses additional model tokens and counts toward the same chat quota. Turn off “대화 후 문서 자동 정리” to generate only when needed. Direct editing turns automatic generation off to protect intentional changes. “문서 저장” saves manual edits; “AI로 정리” incorporates the conversation into the working draft. Review generated facts and wording before publishing. AI output is not automatically source-verified.

“버전 저장 · 발행 검토” snapshots the document and complete inherited/new transcript privately, then opens a publication review. “이 버전 공개 발행” publishes both document and source dialogue. Further saves create child revisions; they do not overwrite earlier snapshots. Forks/rebuttals start at v1 on their own branch; revisions increment the parent’s version. Desktop displays all three panels; tablet/mobile switch between conversation and document, with a topic tab on mobile.

Failed provider calls preserve saved history/documents. Revisions and a per-conversation database lease reject simultaneous edits. Repeating the last successful request ID returns the saved result. Each working conversation allows 20 exchanges; save a version and continue a new revision for more. Documents are limited to 30,000 characters and provider input/output is bounded.

Workspace APIs (writes require a browser session and same origin; public exploration reads allow guests):
- `GET/POST /api/conversations` — recent conversations / create private conversation with a topic.
- `GET/PATCH /api/conversations/:id` — restore / save title, topic and `document_body` using the current revision; legacy reflection fields remain supported.
- `POST /api/chat` with `action: "document"`, conversation ID, revision, request ID and provider — generate and save the working document without altering the transcript.
- `POST /api/conversations/:id/draft` — snapshot document, transcript, and lineage privately.
- `GET /api/explorations/search?scope=public|mine&q=...` — visibility-scoped search plus visible ancestors/descendants.
- `GET /api/explorations/:id` — paired document, source dialogue, and visible lineage.
- `POST /api/explorations/:id/branch` with `kind: "revision"|"fork"|"rebuttal"` — new private working branch; revision requires ownership.
- `POST /api/explorations/:id/publish` — explicit owner-only publishing.

## Branching, comparison, and document reuse

Every question has “이 질문 바꿔 분기”; every answer has “이 답변에서 분기”. The first copies only the conversation before the selected question and places that question in the input for editing. The second copies the conversation through the selected answer. Both start a private fork or rebuttal, keep the original intact, and require another send action before calling an AI. Branching from a working conversation first preserves its current state as a private immutable snapshot.

The branch records its message index, mode and excerpt. For an earlier point in a working conversation, it uses the latest saved document checkpoint at or before that point. Later answers and later document content are excluded. Older published snapshots have no earlier document checkpoints: a partial branch starts with an empty document for regeneration rather than importing the final document. A full branch retains the complete paired document and conversation.

“버전 차이” compares the current document against an accessible version in the same family. It shows exact added/deleted Markdown lines, title/topic changes, the common conversation prefix and each version's remaining messages. This does not call an LLM or claim to be a semantic summary. Large documents use a bounded common-prefix/suffix diff instead of the more detailed line alignment. Private versions remain visible only to their owner, including comparison endpoints.

Use “＋ 참고” in the library or “이 글 참고해서 새 글 쓰기” on an opened article to select up to three documents for the next conversation. The server checks source visibility again on every AI request and passes the first 3,000 characters of each selected document, plus bounded question/current-view metadata. An answer's “이 답변에 전달한 자료” banner records the IDs actually supplied (`injected_ids` in the response). A branch separately labels its inherited conversation/document context. The banner reports supplied context, not proof that the AI used every source or verified its claims. Removing a reference affects subsequent requests; existing answers and their provenance remain in the history.

Additional API fields and routes:
- `POST /api/conversations` accepts optional `source_ids`; `PATCH /api/conversations/:id` updates them with revision checking.
- `POST /api/conversations/:id/branch` takes `revision`, `message_index`, `mode: "rewrite"|"continue"`, and `kind: "fork"|"rebuttal"`.
- `POST /api/explorations/:id/branch` accepts the same optional point fields (without a working revision). Omitting them retains full-document branching.
- `GET /api/explorations/:id` includes accessible family `versions`.
- `GET /api/conversations/:id/compare?base=<exploration-id>` and `GET /api/explorations/:id/compare?base=<exploration-id>` return document/transcript differences. Without `base`, the working snapshot or parent is used.

Design reference: [coral MVP screen plan](https://claude.ai/artifact/Qkb7h279DR6XrBGAj1W4nC) and [alter-ai's knowledge-loop test](https://github.com/wilcoco/alter-ai/blob/claude/mvp-build-deploy-zuf8tv/tests/test_one_wheel.py). This implementation adapts preserved originals and visible knowledge reuse for a personal AI co-created blog. It does not import that project's Python code, automatic canon promotion, or implicit sharing policy. Publication stays explicit; point support expresses support, not a truth verdict. The integration test checks that a saved document's excerpt actually reaches the next model request and its ID is returned and persisted with the answer.

## Free point support

This is a cost-free expression of support, not a payment or financial investment. Points cannot be bought, sold, redeemed, or cashed out and have no monetary value. Each account receives a one-time 1,000P allocation when its wallet is first used. No real-money or daily refill mechanism is included.

Choose a percentage of your current balance (UI: 1%, 5%, 10%, 25%, 50%, 100%) to support a published article. The debit is rounded down to whole points. The first support goes entirely to the author. Later support allocates 70% to the author and up to 30% to earlier supporters, proportionally to their cumulative support of that exact article/version. Integer rounding remainder goes to the author. The current supporter is excluded from that request's earlier-supporter pool, and authors cannot support their own articles. If no other earlier supporter qualifies, the author receives everything. A new version does not inherit support balances. Further rewards depend on future support and are not guaranteed.

Example: A supports 100P first (author +100P). B later supports 200P (author +140P, A +60P). A's original support remains 100P in the allocation weight; received rewards are spendable wallet points, not automatic reinvestments.

- `GET /api/support/wallet` — own balance, cumulative support, received rewards.
- `GET /api/explorations/:id/support` — article totals and own support/reward summary.
- `POST /api/explorations/:id/support` — `{request_id, percentage, expected_balance}`; UUID retry deduplication and stale-balance rejection.

Wallet debits, author/early-supporter credits, positions, and the ledger are committed in one PostgreSQL transaction. A transaction lock serializes distribution and prevents double spending. Every support event's ledger sums to zero; welcome allocations are recorded separately. The personal blog displays the balance and totals. Before a broad public launch, add account-abuse protections: free account creation currently makes coordinated multi-account point manipulation possible.

The legacy `POST /api/chat` messages-array interface remains available for existing browser clients. Only the conversation-ID flow persists history.

## Connect Claude

Open:

https://exploration-web-production.up.railway.app/connect/claude

The connector URL is:

```
https://exploration-web-production.up.railway.app/mcp
```

Until Exploration is accepted into Claude's Connectors Directory, an individual user must add the custom connector once in Claude. After that initial connector addition, authentication is normal sign-in + consent; users do not copy API keys or bearer tokens.

Claude's web OAuth callback is expected to be:

```
https://claude.ai/api/mcp/auth_callback
```

The server supports public PKCE clients and DCR-compatible clients, including `none`, `client_secret_post`, and `client_secret_basic` token-endpoint authentication methods.

## Example AI commands

> Create a private exploration from our current discussion. Capture my question, starting view, key turns, turning points and current view.

Then, when ready:

> Publish that exploration.

Cross-AI recall:

> Search my exploration history for AI publishing and summarize how my view has changed.

## Railway

Project: `exploration-pub`

Production service: `exploration-web`

Keep the existing service variables:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
NODE_ENV=production
PUBLIC_BASE_URL=https://exploration-web-production.up.railway.app
PORT=3000
```

Add these five variables to **`exploration-pub` → `exploration-web` → Variables**:

| Variable | Initial value | Value to supply when enabling the feature |
| --- | --- | --- |
| `HOSTED_OPENAI_API_KEY` | Empty | The service owner's OpenAI API key |
| `HOSTED_OPENAI_MODEL` | `gpt-4.1-mini` | An OpenAI model available to the configured key |
| `HOSTED_ANTHROPIC_API_KEY` | Empty | The service owner's Anthropic API key |
| `HOSTED_ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | An Anthropic model available to the configured key |
| `BYOK_MASTER_KEY` | `REPLACE_WITH_RANDOM_32_BYTE_HEX` | A newly generated cryptographic 32-byte key, encoded as 64 hexadecimal characters or base64 |

Leaving an API key blank keeps that Hosted provider unconfigured. Only one Hosted provider needs a key to use Hosted chat. If Railway requires a nonempty value, use `not-configured` until replacing it with the real API key. Do not use an actual API key as an example or commit it to this repository.

`BYOK_MASTER_KEY` is an application encryption secret, **not** an OpenAI or Anthropic API key. Generate it once in a private local terminal:

```sh
openssl rand -hex 32
```

Paste the generated value directly into the Railway variable, save it securely, and apply/deploy the variable changes. Never put the value in source code, chat messages, screenshots, or logs. Keep it stable across deployments and retain it with database backups: changing or losing it makes existing saved BYOK keys unreadable. Key rotation requires an explicit migration; if no migration is performed, users must save their provider keys again after a change.

The model variables select the corresponding provider's model for both Hosted and BYOK calls. Users' BYOK API keys belong in their signed-in `/me` settings, not in shared Railway Hosted variables. An API key must have access to the selected model and API usage enabled for messages to succeed.

`.env.example` lists safe sample configuration values. The app reads its process environment; the example file is not automatically loaded. The app initializes its schema, including LLM preferences and encrypted BYOK storage, document/version tables, point wallets/ledger, and three demo explorations automatically. Existing data is retained by additive migrations.

After deploying, verify the latest Railway deployment is `SUCCESS`, `/health` returns `ok`, `/chat` loads (or offers sign-in), and `/me` reports the expected provider status. Once real credentials are configured, send a short message through each enabled provider to check inference end to end.

## Security notes

MVP only. Draft is the default and publishing is a separate tool. New chat/settings mutations require a same-origin JSON request (DELETE requires same origin). Chat has a PostgreSQL-backed limit of 20 requests per user per minute, one in-flight request per user per server process, a 45-second provider timeout, and bounded message/output sizes. These limits are not a substitute for service-wide cost controls before public launch.

Before broad public launch, add:
- service-wide quotas, spending limits, and registration/login rate limiting
- account recovery / email verification
- brute-force protection
- moderation and abuse controls
- stronger audit logging
- CSRF protection for future non-OAuth state-changing web forms
- stricter per-tool OAuth scope enforcement
- a dedicated identity provider or hardened authorization server
- Connector Directory review / registration

## Development checks

```sh
npm ci
npm run typecheck
npm test
# Use a disposable local PostgreSQL database for integration/regression tests:
TEST_DATABASE_URL=postgres://localhost/exploration_test npm test
```

Provider unit tests use mocked HTTP responses; they do not spend tokens or need real API keys. Integration tests use isolated database schemas and exercise encrypted storage, authorization, chat routing, saved conversation isolation, retry deduplication, reference visibility, document generation, immutable paired snapshots, per-message branch checkpoints, exact version diffs, source-to-model reuse, branch visibility, point conservation/distribution, duplicate and concurrent spending protection, and the existing OAuth/MCP flow. Browser checks also cover the actual document renderer and mobile panel switching. A real provider inference smoke test is still needed after supplying real API keys.

## Stack

Node.js 22 + TypeScript + PostgreSQL + server-rendered HTML/CSS.
