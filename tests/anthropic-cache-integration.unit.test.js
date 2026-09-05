import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// buildSynthesisRequest — cached system prompt
// ---------------------------------------------------------------------------

const mockBatchClient = {
  collectBatch: vi.fn(),
  extractText: vi.fn(),
  isRefusal: vi.fn(),
  logBatchUsage: vi.fn(),
  submitBatch: vi.fn(),
};

vi.mock('../batch-client.js', () => mockBatchClient);

vi.mock('../lib/matomo-utils.js', () => ({ normalizeTopArticles: vi.fn() }));
vi.mock('../lib/gsc-date-window.js', () => ({ getLagAwareGscWindow: vi.fn() }));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../lib/altus-db.js', () => ({
  default: { query: vi.fn() },
  readAgentMemory: vi.fn(),
  writeAgentMemory: vi.fn(),
}));
vi.mock('./altwire-matomo-client.js', () => ({
  getTrafficSummary: vi.fn(),
  getTopArticles: vi.fn(),
  getReferrerBreakdown: vi.fn(),
  getSiteSearchKeywords: vi.fn(),
}));
vi.mock('./altwire-gsc-client.js', () => ({
  getSearchPerformance: vi.fn(),
  getSearchOpportunities: vi.fn(),
  getOpportunityZoneQueries: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor() { this.messages = { create: vi.fn() }; }
  },
}));

describe('combined-analytics: cached synthesis request', () => {
  beforeEach(() => {
    vi.resetModules();
    mockBatchClient.submitBatch.mockReset();
  });

  it('marks the system prompt with cache_control when tools are present', async () => {
    const { buildSynthesisRequest } = await import('../handlers/altus-combined-analytics.js');
    const request = buildSynthesisRequest({
      traffic: { sessions: 1 },
      top_articles: [],
    });

    expect(request.tools).toBeDefined();
    expect(Array.isArray(request.system)).toBe(true);
    expect(request.system[request.system.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // The static system text is preserved, just wrapped in a cached block
    expect(request.system[0].text).toContain('editorial analytics strategist');
  });
});

// ---------------------------------------------------------------------------
// writer-client generate — Anthropic path sends cached system
// ---------------------------------------------------------------------------

describe('writer-client: generate caches system prompt', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('sends system as a cached content block array to Anthropic', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'generated copy' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class Anthropic {
        constructor() { this.messages = { create: mockCreate }; }
      },
    }));
    vi.doMock('../lib/ai-cost-tracker.js', () => ({
      logAiUsage: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { generate } = await import('../lib/writer-client.js');
    await generate({ toolName: 'ai_writer', system: 'You are the AltWire writer.', prompt: 'Write.', maxTokens: 4000 });

    expect(mockCreate).toHaveBeenCalledOnce();
    const request = mockCreate.mock.calls[0][0];
    expect(request.system).toEqual([
      { type: 'text', text: 'You are the AltWire writer.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(request.messages).toEqual([{ role: 'user', content: 'Write.' }]);
  });

  it('preserves jsonMode instruction inside the cached system block', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class Anthropic {
        constructor() { this.messages = { create: mockCreate }; }
      },
    }));
    vi.doMock('../lib/ai-cost-tracker.js', () => ({
      logAiUsage: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { generate } = await import('../lib/writer-client.js');
    await generate({ toolName: 'ai_writer', system: 'Base system', prompt: 'Go', jsonMode: true });

    const request = mockCreate.mock.calls[0][0];
    expect(request.system.length).toBe(1);
    expect(request.system[0].text).toContain('Base system');
    expect(request.system[0].text).toContain('Respond with valid JSON only');
    expect(request.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});