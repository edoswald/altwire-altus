import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetDigest = vi.fn();
const mockSendEmail = vi.fn();
const mockReadAgentMemory = vi.fn();
const mockWriteAgentMemory = vi.fn();

vi.mock('../handlers/altus-digest.js', () => ({
  getAltwireMorningDigest: mockGetDigest,
}));

vi.mock('../lib/ses-client.js', () => ({
  sendEmail: mockSendEmail,
}));

vi.mock('../lib/altus-db.js', () => ({
  readAgentMemory: mockReadAgentMemory,
  writeAgentMemory: mockWriteAgentMemory,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ET anchors (June = EDT, UTC-4): Wed 08:00 ET (after 5:15 slot),
// Wed 04:00 ET (before slot), Sat 12:00 ET (weekend).
const WED_AFTER_SLOT = '2026-06-17T12:00:00Z';
const WED_BEFORE_SLOT = '2026-06-17T08:00:00Z';
const SAT = '2026-06-20T16:00:00Z';

describe('sendMorningDigestIfMissed', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetDigest.mockReset();
    mockSendEmail.mockReset();
    mockReadAgentMemory.mockReset();
    mockWriteAgentMemory.mockReset();
    mockWriteAgentMemory.mockResolvedValue({ success: true });
    process.env.DEREK_EMAIL = 'derek@example.com';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DEREK_EMAIL;
  });

  it('skips on weekends without sending', async () => {
    vi.setSystemTime(new Date(SAT));
    const { sendMorningDigestIfMissed } = await import('../handlers/altus-digest-mailer.js');
    const result = await sendMorningDigestIfMissed();
    expect(result).toEqual({ status: 'skipped', reason: 'weekend' });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('does not preempt the scheduled send before 5:15 AM ET', async () => {
    vi.setSystemTime(new Date(WED_BEFORE_SLOT));
    const { sendMorningDigestIfMissed } = await import('../handlers/altus-digest-mailer.js');
    const result = await sendMorningDigestIfMissed();
    expect(result).toEqual({ status: 'skipped', reason: 'before_scheduled_time' });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("skips when today's digest was already sent", async () => {
    vi.setSystemTime(new Date(WED_AFTER_SLOT));
    mockReadAgentMemory.mockResolvedValue({
      success: true,
      value: JSON.stringify({ status: 'sent', date: '2026-06-17' }),
    });
    const { sendMorningDigestIfMissed } = await import('../handlers/altus-digest-mailer.js');
    const result = await sendMorningDigestIfMissed();
    expect(result).toEqual({ status: 'skipped', reason: 'already_sent', date: '2026-06-17' });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends when the scheduled digest was missed, and records sent status', async () => {
    vi.setSystemTime(new Date(WED_AFTER_SLOT));
    mockReadAgentMemory.mockResolvedValue({ success: false });
    mockGetDigest.mockResolvedValue({ date: '2026-06-17' });
    mockSendEmail.mockResolvedValue({ success: true });

    const { sendMorningDigestIfMissed } = await import('../handlers/altus-digest-mailer.js');
    const result = await sendMorningDigestIfMissed();

    expect(result).toEqual({ status: 'sent', date: '2026-06-17' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const statusWrite = mockWriteAgentMemory.mock.calls.find((c) => c[1] === 'altus:digest:send_status');
    expect(statusWrite).toBeTruthy();
    expect(JSON.parse(statusWrite[2])).toEqual(expect.objectContaining({ status: 'sent', date: '2026-06-17' }));
  });

  it('retries after a prior failure for the same day', async () => {
    vi.setSystemTime(new Date(WED_AFTER_SLOT));
    mockReadAgentMemory.mockResolvedValue({
      success: true,
      value: JSON.stringify({ status: 'failed', date: '2026-06-17', error: 'boom' }),
    });
    mockGetDigest.mockResolvedValue({ date: '2026-06-17' });
    mockSendEmail.mockResolvedValue({ success: true });

    const { sendMorningDigestIfMissed } = await import('../handlers/altus-digest-mailer.js');
    const result = await sendMorningDigestIfMissed();

    expect(result).toEqual({ status: 'sent', date: '2026-06-17' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('reports failure (for a later retry) when the send throws', async () => {
    vi.setSystemTime(new Date(WED_AFTER_SLOT));
    mockReadAgentMemory.mockResolvedValue({ success: false });
    mockGetDigest.mockRejectedValue(new Error('digest build failed'));

    const { sendMorningDigestIfMissed } = await import('../handlers/altus-digest-mailer.js');
    const result = await sendMorningDigestIfMissed();

    expect(result.status).toBe('failed');
    expect(result.error).toBe('digest build failed');
    const statusWrite = mockWriteAgentMemory.mock.calls.find((c) => c[1] === 'altus:digest:send_status');
    expect(JSON.parse(statusWrite[2])).toEqual(expect.objectContaining({ status: 'failed' }));
  });
});
