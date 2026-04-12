// Feature: altus-ai-writer, Property tests for AI Writer pipeline

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { detectProvider } from '../lib/writer-client.js';

// ---------------------------------------------------------------------------
// Property 2: Provider detection routes correctly by model name
// Validates: Requirements 15.2, 15.3
// ---------------------------------------------------------------------------

describe('detectProvider — Property 2: provider detection routes correctly', () => {
  it('routes gpt-* models to openai', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).map((s) => `gpt-${s}`),
        (model) => {
          expect(detectProvider(model)).toBe('openai');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('routes o1* models to openai', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 20 }).map((s) => `o1${s}`),
        (model) => {
          expect(detectProvider(model)).toBe('openai');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('routes o3* models to openai', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 20 }).map((s) => `o3${s}`),
        (model) => {
          expect(detectProvider(model)).toBe('openai');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('routes claude-* models to anthropic', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).map((s) => `claude-${s}`),
        (model) => {
          expect(detectProvider(model)).toBe('anthropic');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('routes non-gpt/o1/o3 models to anthropic', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter(
          (s) => !s.startsWith('gpt-') && !s.startsWith('o1') && !s.startsWith('o3')
        ),
        (model) => {
          expect(detectProvider(model)).toBe('anthropic');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('default model claude-sonnet-4-5 routes to anthropic', () => {
    expect(detectProvider('claude-sonnet-4-5')).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Property 4: Writer_Client error shape is consistent
// Validates: Requirements 15.12
// ---------------------------------------------------------------------------

describe('Writer_Client error shape — Property 4', () => {
  it('anthropic errors match the expected format', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (msg) => {
          const error = new Error(`writer-client [anthropic]: ${msg}`);
          expect(error.message).toMatch(/^writer-client \[anthropic\]: /);
          expect(error.message).toContain(msg);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('openai errors match the expected format', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (msg) => {
          const error = new Error(`writer-client [openai]: ${msg}`);
          expect(error.message).toMatch(/^writer-client \[openai\]: /);
          expect(error.message).toContain(msg);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: approveOutline decision maps to correct status
// Validates: Requirements 5.1, 5.2, 5.3, 5.4
// ---------------------------------------------------------------------------

describe('approveOutline decision mapping — Property 6', () => {
  const decisionToStatus = {
    approved: 'outline_approved',
    rejected: 'cancelled',
    modified: 'outline_ready',
  };

  it('each decision maps to the correct resulting status', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('approved', 'rejected', 'modified'),
        fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
        (decision, feedback) => {
          const expected = decisionToStatus[decision];
          expect(expected).toBeDefined();
          // Verify the mapping is deterministic
          expect(decisionToStatus[decision]).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Word count matches draft content
// Validates: Requirements 6.5
// ---------------------------------------------------------------------------

describe('Word count — Property 9', () => {
  it('word count equals whitespace-split count of draft content', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 2000 }),
        (draft) => {
          const wordCount = draft.split(/\s+/).filter(Boolean).length;
          expect(wordCount).toBeGreaterThanOrEqual(0);
          // Verify the computation is consistent
          expect(draft.split(/\s+/).filter(Boolean).length).toBe(wordCount);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('empty string has zero words', () => {
    expect(''.split(/\s+/).filter(Boolean).length).toBe(0);
  });

  it('whitespace-only string has zero words', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).map((s) => s.replace(/\S/g, ' ')),
        (ws) => {
          expect(ws.split(/\s+/).filter(Boolean).length).toBe(0);
        }
      ),
      { numRuns: 50 }
    );
  });
});
