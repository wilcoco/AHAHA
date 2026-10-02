# Exploration MVP

A human-first publishing layer for people who think with AI.

Users keep using their own ChatGPT, Claude, Cursor, Codex, or another MCP-capable client. This service does **not** call an LLM. It stores private drafts, publishes selected explorations, preserves optional source messages, and keeps a creator identity across AI providers.

## Live

- Web: https://exploration-web-production.up.railway.app
- Remote MCP: https://exploration-web-production.up.railway.app/mcp

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
- `/me` creator registration / token / private list
- `/mcp` Remote MCP endpoint
- `/health` health check

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

Create a creator at `/me`. The site shows:
- MCP URL: `https://exploration-web-production.up.railway.app/mcp`
- Bearer token: `exp_...`

Use the token as `Authorization: Bearer exp_...`.

The token is stored in PostgreSQL as a SHA-256 hash. The browser session uses an HttpOnly SameSite=Lax cookie.

## Example AI commands

> Create a private exploration from our current discussion. Capture my question, starting view, key turns, turning points and current view.

Then, when ready:

> Publish that exploration.

Cross-AI recall:

> Search my exploration history for AI publishing and summarize how my view has changed.

## Railway

Required variables:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://exploration-web-production.up.railway.app
```

The app initializes the schema and three demo explorations automatically.

## Security notes

MVP only. Before broad public launch add OAuth-based MCP authorization, token rotation, rate limiting, moderation, CSRF protection for future state-changing web actions, stricter payload validation, and abuse controls.

## Stack

Node.js + TypeScript + PostgreSQL + server-rendered HTML/CSS + Railway.
