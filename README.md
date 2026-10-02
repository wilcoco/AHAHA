# Exploration MVP

A human-first publishing layer for people who think with AI.

**Live web:** https://exploration-web-production.up.railway.app  
**Claude connect page:** https://exploration-web-production.up.railway.app/connect/claude  
**Remote MCP:** https://exploration-web-production.up.railway.app/mcp  
**Repository:** wilcoco/AHAHA (temporary repository name for this MVP)

Users keep using their own Claude, ChatGPT, Cursor, Codex, or another MCP-capable client. This service does **not** call an LLM. It stores private drafts, publishes selected explorations, preserves optional source messages, and keeps a creator identity across AI providers.

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
- `/me` creator account / private list
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

Required variables:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
NODE_ENV=production
PUBLIC_BASE_URL=https://exploration-web-production.up.railway.app
PORT=3000
```

The app initializes the schema and three demo explorations automatically.

## Security notes

MVP only. Draft is the default and publishing is a separate tool.

Before broad public launch, add:
- production rate limiting
- account recovery / email verification
- brute-force protection
- moderation and abuse controls
- stronger audit logging
- CSRF protection for future non-OAuth state-changing web forms
- stricter per-tool OAuth scope enforcement
- a dedicated identity provider or hardened authorization server
- Connector Directory review / registration

## Stack

Node.js 22 + TypeScript + PostgreSQL + server-rendered HTML/CSS.
