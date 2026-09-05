import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor() { this.messages = { create: mockCreate }; }
  },
}));

vi.mock('../batch-client.js', () => ({
  submitBatch: vi.fn(),
  waitForBatch: vi.fn(),
  logBatchUsage: vi.fn(),
  collectBatch: vi.fn(),
  isRefusal: vi.fn(),
  extractText: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { submitBatch, waitForBatch, logBatchUsage } from '../batch-client.js';
import {
  MODEL,
  MAX_PROS_CONS,
  buildReviewBatchRequests,
  buildReviewPrompt,
  buildReviewSystemPrompt,
  parseScoreText,
  scoreReviewsInBatch,
} from '../lib/review-scoring.js';

const review = (wpId, text = 'A review body.') => ({
  wp_id: wpId,
  title: `Review ${wpId}`,
  categories: ['Reviews'],
  raw_text: text,
});

describe('review-scoring: prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('system prompt is static and mentions the hard pros/cons limit', () => {
    const system = buildReviewSystemPrompt();
    expect(system).toContain('AltWire music publication review article');
    expect(system).toContain(`maximum ${MAX_PROS_CONS} pros`);
  });

  it('user prompt carries title, categories, and truncated body', () => {
    const prompt = buildReviewPrompt({ wp_id: 1, title: 'T', categories: ['Reviews', 'Albums'], raw_text: 'x'.repeat(7000) });
    expect(prompt).toContain('TITLE: T');
    expect(prompt).toContain('WP CATEGORIES: Reviews, Albums');
    expect(prompt).toContain('[...truncated for analysis...]');
    expect(prompt.length).toBeLessThan(6300);
  });
});

describe('review-scoring: parseScoreText', () => {
  it('parses the first JSON object and caps pros/cons', () => {
    const parsed = parseScoreText(' preamble {"type":"product","pros":["1","2","3","4","5","6","7"],"cons":["c1"],"ratings":{"Sound":8}} trailer');
    expect(parsed.type).toBe('product');
    expect(parsed.pros).toHaveLength(MAX_PROS_CONS);
    expect(parsed.cons).toHaveLength(1);
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseScoreText('no json here')).toThrow(/No JSON object/);
  });
});

describe('review-scoring: buildReviewBatchRequests', () => {
  it('uses wp_id as custom_id and ships the cached system prompt', () => {
    const requests = buildReviewBatchRequests([review(123), review(456)]);

    expect(requests).toHaveLength(2);
    expect(requests[0].custom_id).toBe('123');
    expect(requests[0].params.model).toBe(MODEL);
    expect(requests[0].params.max_tokens).toBe(1500);
    expect(Array.isArray(requests[0].params.system)).toBe(true);
    expect(requests[0].params.system[requests[0].params.system.length - 1].cache_control)
      .toEqual({ type: 'ephemeral' });
    expect(requests[0].params.messages[0].content).toContain('TITLE: Review 123');
  });
});

describe('review-scoring: scoreReviewsInBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits requests, waits for results, and maps parsed scores by custom_id', async () => {
    submitBatch.mockResolvedValue('batch-r1');
    waitForBatch.mockResolvedValue([
      {
        custom_id: '123',
        result: {
          type: 'succeeded',
          message: { model: MODEL, usage: { input_tokens: 10 }, content: [{ type: 'text', text: '{"type":"concert"}' }] },
        },
      },
      {
        custom_id: '456',
        result: {
          type: 'succeeded',
          message: { model: MODEL, usage: { input_tokens: 10 }, content: [{ type: 'text', text: '{"type":"product","product_type":"album","ratings":{"Sound":9}}' }] },
        },
      },
    ]);

    const results = await scoreReviewsInBatch(buildReviewBatchRequests([review(123), review(456)]));

    expect(submitBatch).toHaveBeenCalledTimes(1);
    expect(logBatchUsage).toHaveBeenCalledWith('batch-r1', expect.any(Array), 'score_reviews');
    expect(results.get('123').parsed).toEqual({ type: 'concert' });
    expect(results.get('456').parsed.product_type).toBe('album');
    expect(results.get('456').error).toBeNull();
  });

  it('records errored batch results as per-review errors', async () => {
    submitBatch.mockResolvedValue('batch-r2');
    waitForBatch.mockResolvedValue([
      {
        custom_id: '123',
        result: { type: 'errored', error: { message: 'rate limited' } },
      },
    ]);

    const results = await scoreReviewsInBatch(buildReviewBatchRequests([review(123)]));

    expect(results.get('123').parsed).toBeNull();
    expect(results.get('123').error).toBe('rate limited');
  });

  it('marks every request in a chunk as errored when submission fails', async () => {
    submitBatch.mockRejectedValue(new Error('ANTHROPIC_API_KEY not configured'));

    const results = await scoreReviewsInBatch(buildReviewBatchRequests([review(1), review(2)]));

    expect(results.get('1').error).toMatch(/ANTHROPIC_API_KEY/);
    expect(results.get('2').error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('treats parse failures as per-review errors', async () => {
    submitBatch.mockResolvedValue('batch-r3');
    waitForBatch.mockResolvedValue([
      {
        custom_id: '123',
        result: {
          type: 'succeeded',
          message: { model: MODEL, usage: {}, content: [{ type: 'text', text: 'not json' }] },
        },
      },
    ]);

    const results = await scoreReviewsInBatch(buildReviewBatchRequests([review(123)]));

    expect(results.get('123').parsed).toBeNull();
    expect(results.get('123').error).toMatch(/No JSON object/);
  });
});