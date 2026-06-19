import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('tracing.observe Laminar fallback', () => {
  const originalKey = process.env.LMNR_PROJECT_API_KEY;

  beforeEach(() => {
    vi.resetModules();
    process.env.LMNR_PROJECT_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.LMNR_PROJECT_API_KEY;
    } else {
      process.env.LMNR_PROJECT_API_KEY = originalKey;
    }
    vi.restoreAllMocks();
  });

  it('falls back without double-invoking the handler when Laminar observe throws early', async () => {
    vi.doMock('@lmnr-ai/lmnr', () => ({
      observe: vi.fn(() => {
        throw new Error('laminar unavailable');
      }),
    }));

    const { observe } = await import('../tracing.js');
    await observe({ name: 'prime_trace', spanType: 'DEFAULT' }, async () => 'prime');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const handler = vi.fn().mockResolvedValue({ ok: true });
    const result = await observe({ name: 'fallback_trace', spanType: 'DEFAULT' }, handler);

    expect(result).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
