import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockReadAgentMemory = vi.fn();
const mockWriteAgentMemory = vi.fn();
const mockLogAltusEvent = vi.fn();

vi.mock('../lib/altus-db.js', () => ({
  default: { query: mockQuery },
  readAgentMemory: mockReadAgentMemory,
  writeAgentMemory: mockWriteAgentMemory,
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

    mockReadAgentMemory.mockResolvedValue({ success: false });
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
});
