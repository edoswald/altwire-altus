import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('altus-weekly-brief batching', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DEREK_EMAIL', 'derek@example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('submits the weekly brief as a Fable batch and records it for collection', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const submitBatch = vi.fn().mockResolvedValue('msgbatch-weekly');

    vi.doMock('../handlers/altus-digest.js', () => ({
      getAltwireMorningDigest: vi.fn().mockResolvedValue({ highlights: [] }),
    }));
    vi.doMock('../lib/altus-db.js', () => ({
      default: { query: mockQuery },
      hasDbConfig: vi.fn().mockReturnValue(true),
      readAgentMemory: vi.fn().mockResolvedValue({ success: false }),
      writeAgentMemory: vi.fn(),
    }));
    vi.doMock('../lib/writer-client.js', () => ({
      generate: vi.fn(),
    }));
    vi.doMock('../lib/markdown.js', () => ({
      markdownToHtml: vi.fn((value) => `<p>${value}</p>`),
    }));
    vi.doMock('../lib/ses-client.js', () => ({
      sendEmail: vi.fn(),
    }));
    vi.doMock('../logger.js', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));
    vi.doMock('../batch-client.js', () => ({
      submitBatch,
      collectBatch: vi.fn(),
      logBatchUsage: vi.fn(),
      extractText: vi.fn(),
      isRefusal: vi.fn().mockReturnValue(false),
    }));

    const { sendAltusWeeklyBrief } = await import('../handlers/altus-weekly-brief.js');
    const result = await sendAltusWeeklyBrief();

    expect(result).toMatchObject({ success: true, batch_id: 'msgbatch-weekly' });
    expect(submitBatch).toHaveBeenCalledOnce();
    const request = submitBatch.mock.calls[0][0][0];
    expect(request.params.model).toBe('claude-fable-5');
    expect(request.params.max_tokens).toBe(4000);
    expect(request.params.output_config).toEqual({ effort: 'high' });

    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO altus_weekly_brief_batches');
    expect(mockQuery.mock.calls[0][1][0]).toBe('msgbatch-weekly');
  });
});
