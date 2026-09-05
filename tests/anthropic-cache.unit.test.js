import { describe, it, expect } from 'vitest';
import { withCachedSystem, withRollingConversationCache } from '../lib/anthropic-cache.js';

describe('withCachedSystem', () => {
  it('wraps a string system prompt into a cached block array', () => {
    const out = withCachedSystem('You are hal.');
    expect(out).toEqual([
      { type: 'text', text: 'You are hal.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('places the breakpoint on the last block when given an array', () => {
    const out = withCachedSystem([
      { type: 'text', text: 'prefix' },
      { type: 'text', text: 'suffix' },
    ]);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ type: 'text', text: 'prefix' });
    expect(out[1]).toEqual({ type: 'text', text: 'suffix', cache_control: { type: 'ephemeral' } });
  });

  it('preserves non-text block properties on the cached block', () => {
    const out = withCachedSystem([
      { type: 'tool_result', tool_use_id: 'x', content: 'result' },
    ]);
    expect(out[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'x',
      content: 'result',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('does not mutate the input array', () => {
    const input = [{ type: 'text', text: 'a' }];
    withCachedSystem(input);
    expect(input[0].cache_control).toBeUndefined();
  });

  it('returns an empty array unchanged when given an empty array', () => {
    expect(withCachedSystem([])).toEqual([]);
  });
});

describe('withRollingConversationCache', () => {
  it('caches a string-content last message', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const out = withRollingConversationCache(messages);
    expect(out[0]).toEqual({ role: 'user', content: 'hello' });
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi there', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('caches only the last block of an array-content message', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'result' },
        { type: 'tool_result', tool_use_id: 't1', content: 'output' },
      ],
    }];
    const out = withRollingConversationCache(messages);
    expect(out[0].content[0]).toEqual({ type: 'text', text: 'result' });
    expect(out[0].content[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'output',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('returns messages unchanged when the last message has empty/unwrappable content', () => {
    const messages = [{ role: 'user', content: [] }];
    expect(withRollingConversationCache(messages)).toBe(messages);

    const emptyArr = [];
    expect(withRollingConversationCache(emptyArr)).toBe(emptyArr);
  });

  it('returns non-array input unchanged', () => {
    expect(withRollingConversationCache(null)).toBeNull();
    expect(withRollingConversationCache(undefined)).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    withRollingConversationCache(messages);
    expect(messages[0].content).toBe('hello');
  });
});