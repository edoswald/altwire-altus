import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockReadAgentMemory = vi.fn();
const mockWriteAgentMemory = vi.fn();
const mockLogAltusEvent = vi.fn();
const mockSendMorningDigestIfMissed = vi.fn();

vi.mock('../lib/altus-db.js', () => ({
  default: { query: mockQuery },
  readAgentMemory: mockReadAgentMemory,
  writeAgentMemory: mockWriteAgentMemory,
}));

// The heartbeat retries a missed morning digest via the mailer; mock it so the
// heartbeat test stays hermetic (no real digest build / email / DB queries).
vi.mock('../handlers/altus-digest-mailer.js', () => ({
  sendMorningDigestIfMissed: mockSendMorningDigestIfMissed,
}));

vi.mock('../altus-event-log.js', () => ({
  logAltusEvent: mockLogAltusEvent,
}));

vi.mock('../tracing.js', () => ({
  observe: async (_meta, fn) => fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('altus-heartbeat operational checks', () => {
  beforeEach(() => {
    vi.resetModules();
    mockQuery.mockReset();
    mockReadAgentMemory.mockReset();
    mockWriteAgentMemory.mockReset();
    mockLogAltusEvent.mockReset();
    mockSendMorningDigestIfMissed.mockReset();
    mockSendMorningDigestIfMissed.mockResolvedValue({ status: 'skipped', reason: 'already_sent' });
  });

  it('includes overdue commitments and due watch items in heartbeat conditions', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [] });

    // Fresh reflection memory so reflection_stale doesn't breach — this test
    // is about overdue commitments and due watch items, not reflection age.
    mockReadAgentMemory.mockImplementation((_agent, key) =>
      key === 'hal:altwire:combined_synthesis'
        ? Promise.resolve({ success: true, value: JSON.stringify({ generated_at: new Date().toISOString() }) })
        : Promise.resolve({ success: false }),
    );
    mockWriteAgentMemory.mockResolvedValue({ success: true });

    const { runAltusHeartbeat } = await import('../handlers/altus-heartbeat.js');
    const result = await runAltusHeartbeat();

    expect(result.alerts_sent).toBe(2);
    expect(mockQuery.mock.calls.some((call) => call[0].includes('FROM altus_commitments'))).toBe(true);
    expect(mockQuery.mock.calls.some((call) => call[0].includes('FROM altus_watch_items'))).toBe(true);

    const heartbeatLogCall = mockQuery.mock.calls.find(
      (call) => call[0].includes('INSERT INTO altus_heartbeat_log') && call[1]?.[6],
    );
    expect(JSON.parse(heartbeatLogCall[1][6])).toEqual(expect.objectContaining({
      overdue_commitments: 2,
      due_watch_items: 1,
    }));
  });

  it('attempts a missed morning digest send and counts a recovered send as acted', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })            // listScheduledTasks
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // upcoming review deadlines
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // overdue loaners
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // stale proposed items
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // overdue commitments
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // due watch items
      .mockResolvedValueOnce({ rows: [] });              // heartbeat log insert

    mockReadAgentMemory.mockResolvedValue({ success: false });
    mockWriteAgentMemory.mockResolvedValue({ success: true });
    mockSendMorningDigestIfMissed.mockResolvedValue({ status: 'sent', date: '2026-06-17' });

    const { runAltusHeartbeat } = await import('../handlers/altus-heartbeat.js');
    const result = await runAltusHeartbeat();

    expect(mockSendMorningDigestIfMissed).toHaveBeenCalledTimes(1);
    expect(result.items_acted).toBe(1);
  });
});
