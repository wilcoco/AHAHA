# Conversation publishing foundations — Lagora reference implementation

This change adapts interaction patterns observed in Lagora on 2026-10-12. It does not copy Lagora code, branding, or its payment model. AHAHA keeps its conversation/document pairing, version lineage, rebuttals and free-point support.

## Implemented

| Reference behavior | AHAHA implementation |
| --- | --- |
| Conversation as the publication | A conversation can be saved and published without a generated document; automatic document generation starts off. |
| Publication review | Select messages, edit/mask text, title and author note; opt into attaching a reviewed document or sharing the system prompt. Live reader preview. |
| Public vs private | Working conversation stays private. Only selected content is projected into the published snapshot. Excluded summaries, reference metadata and branch quotes do not leak into the public copy. |
| Limited audience | Share a reviewed snapshot with up to 20 existing usernames. Recipients find it under Received. No anonymous/public feed access. |
| Audience inheritance | Forks and reference-based conversations inherit recipient restrictions; publishing cannot widen their audience. This is access control within AHAHA, not copy prevention or corporate DLP. |
| Per-message branches | Rewrite a question, continue after an answer, quote one answer, or prepare an alternative answer from the preceding question. Originals remain intact; alternative answers are separate branches. |
| Stable positions | Logical message UUIDs survive snapshots and forks; indexed callers remain compatible and mismatched UUID/index pairs are rejected. Message links target UUIDs. |
| Model context | Full inherited transcript is included within the existing bounded context. Oversized requests stop explicitly rather than silently losing earlier messages. Quote mode includes only the selected answer. |
| Fork setup | Account default and per-fork choice between own prompt and the author's shared prompt. Credentials are never inherited. Author-model cloning is not implemented. |
| Conversation import/export | Paste alternating questions/answers separated by a `>>>>>` line, label the source, inspect privately; export own conversation as JSON. |
| Reader retention | Private saved items, creator subscriptions, subscription discovery, new publication/fork/invitation notifications and per-notification read state. Private working forks do not notify or disclose their existence. |
| AI settings | Account defaults and per-conversation instructions, existing encrypted OpenAI/Anthropic BYOK plus explicit short-call connection check. |
| Usage | Last 100 successful calls, provider/model, chat vs document generation, returned input/output tokens. Unknown token counts stay null, not zero. No estimated currency charges. |
| Immutable MCP history | Append creates a new private revision; an already public version cannot be edited in place through publish. OAuth and tool discovery retained. |

## Deliberate boundaries

- Invited readers are not company workspaces. Organization administrators, project membership, offboarding, audit policy and enterprise identity remain separate work.
- Direct OpenAI/Anthropic BYOK remains our provider model; OpenRouter, dozens of model presets, web search and attachments are not implied by this change.
- No opaque cross-conversation memory, automatic people matching, DMs, prompt marketplace, multi-language automatic translation, paid subscriptions or monetary rewards were introduced.
- No shared-link fetching/importer: pasted text avoids exposing arbitrary server fetch or credentials. Maximum 40 imported question/answer pairs, 56,000 characters total, 16,000 per message.
- Published audience/content is fixed for that version. Use a new revision to edit. Older independently created forks are not retroactively redacted.
- Existing open-source MCP drafts remain supported. New privacy projection is used by the web review workflow; MCP publish is an explicit full-content publication.
- Limited-audience content can still be manually copied/exported by authorized readers; the application prevents widening access through its own fork/reference publishing flows.

## Validation

- TypeScript check and 40 tests with a real isolated PostgreSQL schema (no skips), including OAuth PKCE, encryption, idempotence, visibility, redaction, inherited context, stable anchors, usage isolation, reader notifications and restricted reference propagation.
- Native browser interaction against a local server with a mock AI: login, import two question/answer pairs, publish without a document, mask a phrase, exclude a pair, inspect the resulting public copy, quote one answer and send a follow-up, reload the saved reply.
- Production deployment and live provider calls must be reported separately from these local checks. No real user keys were copied into tests.
