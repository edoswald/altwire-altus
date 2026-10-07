import { describe, it, expect } from 'vitest';
import { resolveModel, getResponseText, MODEL_HAIKU, MODEL_OPUS, MODEL_SONNET } from '../lib/model-ids.js';

describe('resolveModel', () => {
  it('falls back when unset', () => {
    expect(resolveModel(undefined, MODEL_OPUS)).toBe('claude-opus-5-5');
    expect(resolveModel('  ', MODEL_SONNET)).toBe('claude-sonnet-5-5');
  });

  it('maps retired IDs pinned in env forward', () => {
    expect(resolveModel('claude-opus-4-8', MODEL_OPUS)).toBe('claude-opus-5-5');
    expect(resolveModel('claude-sonnet-4-5', MODEL_SONNET)).toBe('claude-sonnet-5-5');
    expect(resolveModel('claude-haiku-4-5-20251001', MODEL_HAIKU)).toBe('claude-haiku-5-5');
    expect(resolveModel('claude-fable-5', MODEL_OPUS)).toBe('claude-fable-5-1');
  });

  it('passes current and non-Anthropic IDs through', () => {
    expect(resolveModel('claude-fable-5-1', MODEL_OPUS)).toBe('claude-fable-5-1');
    expect(resolveModel('gpt-4o', MODEL_SONNET)).toBe('gpt-4o');
  });
});

describe('getResponseText', () => {
  it('skips thinking blocks', () => {
    expect(getResponseText({
      content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'pro' }],
    })).toBe('pro');
  });

  it('throws on refusal', () => {
    expect(() => getResponseText({ stop_reason: 'refusal', content: [] })).toThrow(/refused/);
  });
});
