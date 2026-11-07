import { describe, expect, it } from 'vitest';
import { cacheOf } from '@/lib/adapters';
import { NOT_REPORTED, cacheLine } from '@/lib/cache-text';

describe('cacheOf', () => {
  it('reads OpenAI-style cached tokens', () => {
    expect(cacheOf({ usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 640 } } })).toEqual({ cached: 640, prompt: 1000 });
  });
  it('reads Anthropic-style cache reads', () => {
    expect(cacheOf({ usage: { input_tokens: 500, cache_read_input_tokens: 300 } })).toEqual({ cached: 300, prompt: 500 });
  });
  it('keeps a real zero as zero', () => {
    expect(cacheOf({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } } })).toEqual({ cached: 0, prompt: 100 });
  });
  it('says "not reported" (null), not zero, when the server sends no cached-token count', () => {
    expect(cacheOf({ usage: { prompt_tokens: 74614, prompt_tokens_details: null } })).toEqual({ cached: null, prompt: 74614 });
    expect(cacheOf({ usage: { prompt_tokens: 74614 } })).toEqual({ cached: null, prompt: 74614 });
  });
  it('returns nothing without usage', () => {
    expect(cacheOf({})).toBeNull();
    expect(cacheOf({ usage: { prompt_tokens: 0 } })).toBeNull();
  });
});

describe('cacheLine', () => {
  it('shows the numbers, or that the provider does not show them', () => {
    expect(cacheLine({ cached: 640, prompt: 1000 })).toBe('640 of 1,000 prompt tokens from cache (64%)');
    expect(cacheLine({ cached: null, prompt: 74614 })).toBe(`${NOT_REPORTED} (74,614 prompt tokens)`);
    expect(NOT_REPORTED).toBe('not shown by the LLM provider');
  });
});
