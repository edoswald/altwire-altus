import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInfo = vi.fn();
const mockWarn = vi.fn();

vi.mock('../logger.js', () => ({
  logger: {
    info: mockInfo,
    warn: mockWarn,
  },
}));

describe('laminar integration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('initializes Laminar without calling patch when the SDK does not expose it', async () => {
    const initialize = vi.fn();
    const lmnr = { Laminar: { initialize } };
    const loadLaminar = vi.fn().mockResolvedValue(lmnr);
    const loadAnthropic = vi.fn().mockResolvedValue({ default: { sdk: 'anthropic' } });

    const { initializeLaminar } = await import('../lib/laminar-integration.js');
    await initializeLaminar({
      projectApiKey: 'test-key',
      loadLaminar,
      loadAnthropic,
    });

    expect(initialize).toHaveBeenCalledOnce();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('skips signal registration when the SDK does not expose a signals client', async () => {
    const loadLaminar = vi.fn().mockResolvedValue({ Laminar: {} });

    const { registerLaminarSignals } = await import('../lib/laminar-integration.js');

    await expect(registerLaminarSignals({
      projectApiKey: 'test-key',
      loadLaminar,
    })).resolves.toBe(false);

    expect(mockWarn).toHaveBeenCalledWith(
      '[altus-signals] Laminar SDK does not expose a signals client; skipping registration'
    );
  });
});
