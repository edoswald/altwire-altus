import { beforeEach, describe, expect, it, vi } from 'vitest';

// Track retrieve/results call state for waitForBatch tests
const batchState = { retrieveCalls: 0, alwaysInProgress: false };

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor() {
      this.beta = {
        messages: {
          batches: {
            retrieve: vi.fn(async () => {
              batchState.retrieveCalls++;
              const status = batchState.alwaysInProgress || batchState.retrieveCalls === 1
                ? 'in_progress'
                : 'ended';
              return { processing_status: status };
            }),
            results: vi.fn(async function* () {
              yield {
                custom_id: 'r1',
                result: {
                  type: 'succeeded',
                  message: {
                    model: 'claude-haiku-4-5',
                    usage: { input_tokens: 100, output_tokens: 50 },
                  },
                },
              };
            }),
          },
        },
      };
    }
  },
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockLogAiUsage = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/ai-cost-tracker.js', () => ({
  logAiUsage: (...args) => mockLogAiUsage(...args),
}));

import { logBatchUsage, waitForBatch } from '../batch-client.js';

describe('logBatchUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aggregates input, output, and cache tokens and marks the call as batch', async () => {
    const results = [
      {
        custom_id: 'a',
        result: {
          type: 'succeeded',
          message: {
            model: 'claude-haiku-4-5',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 400,
              cache_creation_input_tokens: 200,
            },
          },
        },
      },
      {
        custom_id: 'b',
        result: {
          type: 'succeeded',
          message: {
            model: 'claude-haiku-4-5',
            usage: {
              input_tokens: 30,
              output_tokens: 20,
              cache_read_input_tokens: 600,
              cache_creation_input_tokens: 0,
            },
          },
        },
      },
      { custom_id: 'c', result: { type: 'errored', error: { message: 'bad request' } } },
    ];

    await logBatchUsage('batch-1', results, 'score_reviews');

    expect(mockLogAiUsage).toHaveBeenCalledOnce();
    const [toolName, model, usage, opts] = mockLogAiUsage.mock.calls[0];
    expect(toolName).toBe('score_reviews');
    expect(model).toBe('claude-haiku-4-5');
    expect(usage).toEqual({
      input_tokens: 130,
      output_tokens: 70,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
    });
    expect(opts).toEqual({ isBatch: true });
  });

  it('does nothing when there are no succeeded results', async () => {
    await logBatchUsage('batch-2', [{ custom_id: 'a', result: { type: 'errored' } }], 'tool');
    expect(mockLogAiUsage).not.toHaveBeenCalled();
  });
});

describe('waitForBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchState.retrieveCalls = 0;
    batchState.alwaysInProgress = false;
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('polls until the batch ends and returns collected results', async () => {
    const results = await waitForBatch('batch-3', { intervalMs: 1, timeoutMs: 1000 });

    expect(batchState.retrieveCalls).toBe(2);
    expect(results).toEqual([
      {
        custom_id: 'r1',
        result: {
          type: 'succeeded',
          message: {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      },
    ]);
  });

  it('throws when the batch does not finish before the timeout', async () => {
    batchState.alwaysInProgress = true;

    await expect(
      waitForBatch('batch-4', { intervalMs: 1, timeoutMs: 20 }),
    ).rejects.toThrow(/did not finish within/);
  });
});