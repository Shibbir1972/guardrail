# HTTP API

## Gateway (for agents)

All gateway routes need `Authorization: Bearer grk_live_…` (or `x-api-key`).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/models` | Models this key may use. |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions. Supports streaming. |
| `POST` | `/v1/completions` | Legacy completions. Supports streaming. |

Errors use OpenAI's shape, `{"error": {"message", "type", "code", "param"}}`:

| Status | When |
| --- | --- |
| 400 | The body is not valid JSON. |
| 401 | The key is missing, invalid, revoked or expired. |
| 403 | The model is not allowed for this key (not in its groups, not enabled on any server, or a limit excludes the group). |
| 422 | Schema mismatch under the strict policy. |
| 429 | Rate limit reached. |
| 502 | Every server for the model failed. |

A request stopped by the guard or a custom rule is **not** an error. It returns 200 with an assistant message (see [architecture.md](architecture.md)). Every response carries an `x-guardrail-request-id` header that matches the Activity log, and blocked replies also carry `x-guardrail-blocked: 1`.

## Admin API

Everything is under `/api/admin/` and returns JSON. Failures come back as `{"error": "…"}` with a 4xx status. When an admin password is set, these routes need the session cookie from `POST /api/auth/login` with body `{"password"}`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `servers` | Servers with models, health, prefix-cache rate, limits and access map |
| POST | `servers/discover` | `{url, apiKey?}` → models found at `GET {url}/v1/models` |
| POST | `servers` | `{name, url, apiKey?, role, models, enabled}` |
| PATCH / DELETE | `servers/:id` | Edit or remove a server |
| POST | `servers/:id/rediscover` | Re-read the model list (new models arrive disabled) |
| PATCH | `models/:id` | `{enabled}` |
| POST | `limits` | Create or update a global, server or model limit |
| DELETE | `limits/:id` | |
| GET / POST | `groups` | Tree with resolved settings, or `{name, parentId, description}` to create a group |
| GET / PATCH / DELETE | `groups/:id` | Read (with resolution matrix), rename or move, or delete |
| PUT | `groups/:id/settings` | `{key, setting: {mode, value}}`, or `{key, setting: null}` to inherit again. Keys: `servers`, `models`, `context`, `piguard_enabled`, `piguard_threshold`, `oss_enabled`, `oss_prompt`, `blocked_reply`, `rate_limit`. `piguard_enabled` and `oss_enabled` take `true` or `false` and let one group bypass a check |
| GET / POST | `keys` | List keys, or create one (the response includes the secret, once) |
| POST | `keys/preview` | Effective settings for `{groupId, exceptions}` before creating a key |
| GET / PATCH / DELETE | `keys/:id` | Read, edit (group, exceptions, expiry, revoke), or delete |
| GET / POST | `context` | List files, or create one from `{name, body}` |
| GET / PATCH / DELETE | `context/:id` | Read with history, save a new version, or delete |
| GET / PATCH | `settings` | Global settings (guard, policy prompt, placement, schema policy, default rate) |
| GET | `guard/stats` | 24-hour counts for the three guard lanes |
| POST | `guard/test` | `{text, source: "user" or "tool", groupId}` runs both checks without logging |
| GET | `overview?range=1h\|24h\|7d\|30d` | Dashboard numbers |
| GET | `logs?filter=&q=&limit=&before=` | Activity rows (without the prompts) |
| GET / PATCH | `logs/:id` | One entry including `prompt_file`, plus `prompt` (messages as the client sent them) and `forwarded` (as sent to the model, `null` if it never got there) read from that file; `prompt_expired` is true once the file has been deleted, or `{feedback}` to mark a false alarm |
| GET / POST | `rules` | Custom rules |
| PATCH / DELETE | `rules/:id` | |
| GET | `studio` | Keys (with the models each may use) and schemas for the Studio page |
| POST | `studio/send` | `{keyId or secret, path, headers?, body}` sends a request through the real gateway. Returns the reply, the log entry with its steps, the context files added, and the body forwarded to the model |
| GET | `schemas` | Known schemas and the current policy |
| POST | `schemas/detect` | `{body, path, headers?}` returns the detection scores |
| GET | `summary` | Sidebar counts |
