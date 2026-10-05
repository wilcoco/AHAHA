# Exploration MVP

A human-first publishing layer for people who think with AI.

**Live web:** https://exploration-web-production.up.railway.app  
**Claude connect page:** https://exploration-web-production.up.railway.app/connect/claude  
**Remote MCP:** https://exploration-web-production.up.railway.app/mcp  
**Repository:** wilcoco/AHAHA (temporary repository name for this MVP)

Users can chat in Exploration with a service-provided OpenAI or Anthropic model (Hosted LLM), or save their own provider API key (BYOK). They can also keep using Claude, ChatGPT, Cursor, Codex, or another MCP-capable client through the existing Remote MCP connection. Exploration stores private drafts, publishes selected explorations, preserves optional source messages, and keeps a creator identity across AI providers.

## Core object

An **Exploration** contains:
- opening question
- starting view
- key turns
- turning points
- current view
- optional source conversation

Public pages show the human thinking first. Raw AI dialogue is secondary source material.

## Routes

- `/` public feed
- `/@username` creator profile
- `/@username/:slug` published exploration
- `/me` creator account / private list / Hosted provider status / BYOK settings
- `/chat` three-panel exploration workspace: search, saved conversation, thought map
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

Conversations are stored privately in PostgreSQL after each successful reply, and can be reopened from “Your conversations” or their URL. “New” starts another conversation without deleting the old one. Failed provider calls leave the saved history intact. Revision checks and a database-backed per-conversation lease prevent simultaneous edits/spending; repeating the last successful request ID returns the saved result.

The left panel searches your own drafts/published explorations or the public feed. Read a result before choosing “Use in conversation”. Up to three selected references (title, opening question, and current view) are sent to the chosen model with your next message. Their visibility is checked again on the server. This is keyword search of stored explorations, not live web search.

The right thought map connects selected references to the opening question and subsequent user questions. Nodes open their source or jump to the corresponding message. These are actual recorded questions, not AI-inferred beliefs or a semantic knowledge graph. On tablets the map switches with the conversation; mobile has Search / Conversation / Thought map tabs.

“Reflect & save an exploration” lets the author write their starting view, turning points, and current view. Saving a private draft atomically snapshots those fields and the source conversation. Review the snapshot before pressing “Publish this exploration”, which makes both the reflection and source conversation public. Later conversation edits do not silently change an already-published snapshot. Automatic AI summarization remains a later phase. Existing MCP tools still create and publish explorations through the same core tables.

Workspace APIs (browser session only):
- `GET/POST /api/conversations` — recent conversations / create private conversation.
- `GET/PATCH /api/conversations/:id` — restore / save title and reflection using the current revision.
- `POST /api/conversations/:id/draft` — snapshot a reviewed reflection and transcript privately.
- `GET /api/explorations/search?scope=public|mine&q=...` — visibility-scoped keyword search.
- `GET /api/explorations/:id` — read a public or owned exploration.
- `POST /api/explorations/:id/publish` — explicit owner-only publishing.

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

`.env.example` lists safe sample configuration values. The app reads its process environment; the example file is not automatically loaded. The app initializes its schema, including LLM preferences and encrypted BYOK storage, and three demo explorations automatically.

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

Provider unit tests use mocked HTTP responses; they do not spend tokens or need real API keys. Integration tests use isolated database schemas and exercise encrypted storage, authorization, chat routing, saved conversation isolation, retry deduplication, reference visibility, draft/publication snapshots, and the existing OAuth/MCP flow. A real provider inference smoke test is still needed after supplying real API keys.

## Stack

Node.js 22 + TypeScript + PostgreSQL + server-rendered HTML/CSS.
