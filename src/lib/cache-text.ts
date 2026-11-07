import type { CacheUse } from './adapters';

/** What the pages say when the server's usage reply has no cached-token count (for example vLLM without --enable-prompt-tokens-details). */
export const NOT_REPORTED = 'not shown by the LLM provider';

/** One call's prompt cache use, in words: the real numbers, or that the provider does not report them. */
export function cacheLine(c: CacheUse): string {
  if (c.cached === null) return `${NOT_REPORTED} (${c.prompt.toLocaleString()} prompt tokens)`;
  return `${c.cached.toLocaleString()} of ${c.prompt.toLocaleString()} prompt tokens from cache (${Math.round((c.cached / c.prompt) * 100)}%)`;
}
