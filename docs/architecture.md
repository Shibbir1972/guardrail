# Architecture

GuardRail is one Next.js app with two jobs:

- **Gateway.** `src/app/v1/*` is an OpenAI-compatible API that agents call with a `grk_live_…` key.
- **Admin panel.** `src/app/(admin)/*` holds the UI pages, and `src/app/api/admin/[...path]` is the JSON API behind them.

All state lives in one SQLite file, accessed with `better-sqlite3` (`src/lib/db.ts`).

```
Cline ──► /v1/chat/completions ──► auth ► schema ► access & limits ► rules ► check 1 ► check 2 ► context ► vLLM
                                     │       │          │              │        │         │                  │
                                     401     422      403/429        block    flagged   block ──► streamed   stream back
                                                                                          allow ──► false alarm
```

## A request, step by step (`src/lib/gateway.ts`)

1. **Auth.** The key comes from `Authorization: Bearer …` or `x-api-key`. It is looked up by its SHA-256 hash. Revoked, expired or unknown keys get a 401.
2. **Schema.** `detectSchema` scores the body against six API shapes using weighted signals (`src/lib/schemas.ts`). Under the strict policy, a body that confidently looks like a different shape than the path expects gets a 422.
3. **Access and limits.**
   - The key's group chain is resolved, with the key's own exceptions applied on top as the last layer (see below).
   - The model must be in the effective `models` list, and its server in `servers` when that list is set.
   - Limits set globally, per server or per model can narrow this further by allowed groups and rate limits.
   - The narrowest rate limit applies, counted in a one-minute sliding window in memory (`src/lib/limits.ts`).
4. **Custom rules.** Rules for the key's group chain run against new content (`src/lib/rules.ts`). Each rule can do one of three things:
   - `block` stops the request with the rule's message.
   - `redact` replaces matches with `[REDACTED]` before the request goes on.
   - `escalate` sends the request straight to check 2.
5. **Check 1, PIGuard** (`runCheck1` in `src/lib/guard.ts`).
   - It scans only *new segments*: messages after the last assistant turn, which covers the user's new message and new tool results. Cline's `[tool for x] Result:` text counts as a tool result. The system prompt is scanned only if that option is on.
   - Text is sent in 1800-character windows to vLLM `POST /classify`. The score is `probs[labelIndex]`.
   - If the server can't be reached, built-in patterns score the text instead. A score at or above the group's threshold flags the request.
6. **Check 2, the OSS judge** (`runCheck2`). This runs only for flagged or escalated requests.
   - It sends the group's OSS prompt and the flagged content to `/v1/chat/completions` with `reasoning_effort`, and asks for `{"verdict":"allow|block","reason":"…"}`.
   - `block` returns the blocked reply. `allow` lets the request through, and it is logged as a *false alarm*.
   - A timeout or error follows the "on timeout" setting.
7. **Context.** The policy prompt and the group's context files, in order, are wrapped in `<project_context file="…">` tags. They go at the **top of the first system message** (or just before the last user message, if that placement is chosen). Placing them at the top keeps an identical prefix across requests, so vLLM's automatic prefix caching can reuse it.
8. **Forward.** The request goes to the first healthy server that serves the model. If a server fails before responding, the next one is tried and the failed one is marked down. Streams are passed through as they arrive, and the log row is finalized when the stream ends or the client disconnects.

Every stage records its own duration (`stages`) and a human-readable step (`steps`), which the Activity page shows as the **Why?** timeline.

### The blocked reply (`src/lib/sse.ts`)

A blocked request still gets HTTP 200 with an ordinary assistant message, so agents display it instead of retrying.

- When `stream: true`, the reply is a `text/event-stream` of `chat.completion.chunk` events: a role chunk, then word chunks, then `finish_reason: "stop"`, then `data: [DONE]`.
- Otherwise it is a single `chat.completion`.
- Legacy `/v1/completions` gets `text_completion` objects.

The text comes from the template on the Guard page, with `{reason}` and `{request_id}` filled in.

## Group inheritance (`src/lib/groups.ts`)

Groups form a tree under one root. The settings that inherit are `servers`, `models`, `context`, `piguard_threshold`, `oss_prompt`, `blocked_reply` and `rate_limit`. Each group stores, for each setting, either nothing (inherit) or one of three modes:

| Mode | Lists (servers, models, context) | Values | OSS prompt |
| --- | --- | --- | --- |
| `set` (root only) | starting list | starting value | — |
| `add` | parent's list + these | — | parent's prompt + a section "Added by <group>" |
| `override` | replaces the parent's list | replaces the value | replaces the prompt |

How a setting is resolved:

- `resolveLayers` walks the chain from root to leaf, starting from the global defaults set on the Guard and Context pages.
- A key's exceptions are applied as a final layer named "This key".
- It returns the effective values, which layers contributed to each one (`sources`), and a matrix the Groups page draws as *Effective rules*.

## Data model (`src/lib/db.ts`)

| Table | Holds |
| --- | --- |
| `servers`, `models` | vLLM servers (role `inference` or `guard`) and their discovered models, each with an enabled flag |
| `groups` | tree via `parent_id`; `settings` is JSON of `{key: {mode, value}}` |
| `api_keys` | name, owner, group, `prefix` (first 13 chars), `hash`, `exceptions` JSON, expiry, revoked flag, last used |
| `context_files`, `context_file_versions` | `.md` library with full history |
| `limits` | scope `global` / `server` / `model`, rate limit, allowed groups |
| `rules` | custom WHEN/THEN rules |
| `settings` | one JSON document of global settings (`src/lib/settings.ts`) |
| `request_logs` | one row per request with outcome, check results, `stages` and `steps` JSON, feedback, and the `prompt` and `forwarded` messages as JSON |

## Admin auth

- If `GUARDRAIL_ADMIN_PASSWORD` is set, `src/middleware.ts` requires a session cookie on every page and on `/api/admin/*`. The cookie is an HMAC token signed with `GUARDRAIL_SECRET`.
- `/v1/*`, `/login` and `/api/auth/*` are exempt.
- With no password set, the panel is open, which is meant for local development.
