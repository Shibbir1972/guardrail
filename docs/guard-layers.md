# Guard layers and decision models

Every request that passes authentication goes through an ordered list of **guard layers** before
Opsara adds context and calls the model:

```
After authentication (key, IP, schema, model access, rate limit, custom rules)   ← fixed
  1. layer
  2. layer
  …
Add context, call the model                                                      ← fixed
  after-the-model layers (check the answer, can retry)
Return the answer to the client                                                  ← fixed
```

Layers are edited on the **Guard checks** page. Each group can switch any layer on or off for
itself and its sub-groups ("same as parent / on / off"), like every other group setting.

## A layer

| Field | Meaning |
| --- | --- |
| Type | `classifier` (a scoring model), `judge` (an LLM with a system prompt), `patterns` (built-in injection patterns, no model), `redactor` (built-in secrets and PII redactor, no model), `router` (a decision model picks the model; see [routing.md](routing.md)). |
| Model, server | Any model on any server, on or off for clients. Decision and text models are listed first. |
| Adapter | How to read the model's answer (below). `auto` picks one from the model name. |
| Prompt, block when, allow when | The judge's system prompt and optional extra guidance. Groups can append lines. |
| Threshold, attack class index | For scoring models: a score at or above the threshold is a hit. |
| Runs on | `all`: every request. `flagged`: only when an earlier layer flagged it, or every request when no earlier layer screened it. |
| When it says no | `block` stops the request with the blocked reply. `flag` passes it on as flagged to later layers. `redact` replaces the matches with `[REDACTED]` and continues. |
| If it fails | `allow`, `block`, or (for scoring layers) fall back to the built-in patterns. |
| Time limit | Per call, from 0.2 s up to 10 minutes. A suffix check reads the whole conversation, so give it a generous limit. |
| When it runs | `input` (before the model, default) or `output` (checks the answer; see [after-model-checks.md](after-model-checks.md)). Output layers add **retry**, **Retries**, **When retries run out**, **Retry prompt** and **Only tool calls**. |
| Where the check goes | `prefix` (layer prompt, then the content) or `suffix` (the request exactly as the model gets it, then the question). With **Use the request's model**, the check shares the model call's prompt cache; see [caching.md](caching.md). |
| What this layer reads | New user message, new tool results, the agent's system prompt. Empty uses the global default on the Guard checks page. |
| Decision question | For Decisions-API models: a yes/no, choice or score question, and what each answer does. |

A request still flagged when the pipeline ends is decided by **Flag nobody cleared** (block or allow).
A flag that a later layer clears is logged as a **false alarm**.

The old two checks are migrated into two layers so behaviour does not change: **PIGuard**
(`classifier`, every request, *flag*, fall back to patterns) followed by **OSS judge** (`judge`,
only flagged requests, *block*, fallback = the old "if it fails or times out" setting).

## The decision contract

Whatever the model, every layer produces one shape, and the pipeline only ever sees this:

```ts
{
  verdict: 'allow' | 'block' | 'flag',
  score: number | null,      // 0..1 when the model gives one
  categories: string[],      // e.g. "S1 Violent crimes", "violence", "AWS access key"
  reason: string,
  raw: string,               // the model's answer, shown in the tester and the log
  latency_ms: number,
  error?: string             // set when the call failed or the answer could not be read
}
```

Adapters never throw. A timeout, an HTTP error or an unreadable answer comes back with `error` set,
the layer's fallback decides, and the log shows "Check N · name failed".

## Adapters

| Adapter | Models | Request | How the answer is read |
| --- | --- | --- | --- |
| `classifier` | PIGuard, Prompt-Guard, DeBERTa injection classifiers | `POST /classify` (then `/pooling`) with text windows | Probability at the attack class index (or an injection-like label); the highest window wins. Hit when ≥ threshold. |
| `llama_guard` | Llama Guard 3 / 4 | Chat completion, content as the user turn | `safe`, or `unsafe` followed by codes like `S1,S14`, mapped to the MLCommons hazard names. |
| `yes_no` | ShieldGemma, Granite Guardian | Chat completion with the layer prompt, asking for logprobs | "Yes" means a violation. With logprobs, P(Yes) is the score compared with the threshold. |
| `moderation` | OpenAI-compatible moderation models | `POST /v1/moderations` | `flagged`, `categories`, and the highest `category_scores` value. |
| `json_judge` | Any chat model with a system prompt (gpt-oss-safeguard, Qwen, …) | Chat completion, JSON mode when the server supports it (retried without on 400) | `{"verdict","score","reason","categories"}`; tolerates prose around the JSON and the older `decision` key. |
| `text` | Anything else | Chat completion | Looks for allow / block / safe / unsafe. |
| `custom` | Any model, with a mapping (presets: gpt-oss-safeguard, Qwen3Guard, WildGuard, NemoGuard / Aegis) | Chat, completions, `/classify`, `/v1/moderations` or a raw POST, with an optional body template | JSON paths or regexes for verdict, score, categories and reason, plus value rules (see below). |

Auto-detection from the model name: `llama-guard` → `llama_guard`; `shieldgemma`, `granite-guardian`
→ `yes_no`; `moderation` → `moderation`; `piguard`, `prompt-guard`, `deberta`, `injection`,
`classif` → `classifier`; `qwen3guard`, `wildguard`, `nemoguard`, `aegis` → `custom` with their
preset; otherwise judges use `json_judge` and classifier layers use `classifier`.

## Custom mapping

For a decision model whose answer none of the adapters reads, pick **Custom mapping** in the layer
editor and say where its answer's parts are. No code change is needed.

**Calling it.** Pick the call type: chat completions, completions, `/classify`, `/v1/moderations`, or a
raw POST to a path you give. Optionally write the request body as JSON with these placeholders:
`{input}` (the text to judge), `{policy}` (the layer prompt), `{model}` (inserted as JSON string text,
so write them inside quotes) and `{messages}` (a chat message list, written without quotes).

**Reading it.** Chat and completions read the reply text; the other call types read the whole response.
Each of *Verdict at*, *Score at*, *Categories at* and *Reason at* is either a JSON path — `verdict`,
`result.scores[0]`, `results[*].label`, or a key with spaces such as `User Safety` — or a `/regex/flags`
whose first group is the value. JSON wrapped in prose or code fences is found.

**Deciding.** *Verdict values* has one rule per line, `values => allow | block | flag`, compared without
case (`unsafe, 1, true => block`). A value no rule names gets *Any other value* (flag by default). With no
verdict but a score, a score at or above the layer threshold blocks (*Score means* can flip that for
models where low is unsafe). *Category names* turns codes into names (`S1 = Violent crimes`).

**Testing.** Paste an answer from the model next to the mapping to see how Opsara reads it as you
type. An answer the mapping can't read is never a crash: the decision comes back with an error and the
layer's "if it fails" setting decides, as for every adapter.

Presets: **gpt-oss-safeguard** `{"violation": 0|1, "policy_category", "rationale"}` · **Qwen3Guard**
`Safety: Safe|Unsafe|Controversial` and `Categories:` · **WildGuard** `Harmful request: yes|no` ·
**NemoGuard / Aegis** `{"User Safety": "safe|unsafe", "Safety Categories"}`.

## Finding decision models

Discovery reads `/v1/models` and, optionally, a few extra listings some providers keep apart
(`/v1/models?output_modalities=all`, `/v1/embeddings/models`, `/v1/moderations/models`), merged by id.
A listing that fails is skipped and noted ("some listings unavailable"); discovery only fails when
nothing answers. Models are typed (Text, Image, Audio, Video, Embedding, Rerank, Decision/classifier,
Other) from OpenRouter's architecture, a vLLM task field or the name, and the type can be overridden.
When a listing still misses a model, add it on the server page with **Add a model by id**; it is
marked "added by hand" and kept on rediscovery.
