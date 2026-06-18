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

    expect(result.alerts_sent).toBe(3);
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

  it('claims due scheduled tasks with skip-locked lease semantics', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    mockReadAgentMemory.mockResolvedValue({ success: false });
    mockWriteAgentMemory.mockResolvedValue({ success: true });

    const { runAltusHeartbeat } = await import('../handlers/altus-heartbeat.js');
    await runAltusHeartbeat();

    const pickupCall = mockQuery.mock.calls[0];
    expect(pickupCall[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(pickupCall[0]).toContain("status = 'running'");
    expect(pickupCall[0]).toContain('lease_expires_at');
  });

  it('queues stale proposed action items for review without auto-accepting them', async () => {
    mockQuery.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM altus_scheduled_tasks')) return { rows: [] };
      if (text.includes('FROM altus_reviews')) return { rows: [{ count: '0' }] };
      if (text.includes('FROM altus_loaners')) return { rows: [{ count: '0' }] };
      if (text.includes('SELECT COUNT(*) as count FROM altus_action_items')) return { rows: [{ count: '2' }] };
      if (text.includes('FROM altus_commitments')) return { rows: [{ count: '0' }] };
      if (text.includes('FROM altus_watch_items')) return { rows: [{ count: '0' }] };
      if (text.includes('SELECT id, title, category, signal_source, proposed_at')) {
        return {
          rows: [
            { id: 11, title: 'Refresh Deftones opportunity', category: 'editorial', signal_source: 'reflection', proposed_at: '2026-06-16T10:00:00.000Z' },
            { id: 12, title: 'Tighten NIN SEO framing', category: 'editorial', signal_source: 'reflection', proposed_at: '2026-06-16T11:00:00.000Z' },
          ],
        };
      }
      if (text.includes('INSERT INTO altus_heartbeat_log')) return { rows: [] };
      if (text.includes("UPDATE altus_action_items") && text.includes("status = 'accepted'")) {
        throw new Error('stale items should not be auto-accepted');
      }
      return { rows: [] };
    });

    mockReadAgentMemory.mockImplementation(async (_agent, key) => {
      if (key === 'altus:heartbeat:alert_dedup') return { success: false };
      if (key === 'altus:heartbeat:review_queue') return { success: false };
      if (key.startsWith('altus:news_alert:')) return { success: false };
      if (key === 'hal:altwire:combined_synthesis') return { success: false };
      return { success: false };
    });
    mockWriteAgentMemory.mockResolvedValue({ success: true });

    const { runAltusHeartbeat } = await import('../handlers/altus-heartbeat.js');
    const result = await runAltusHeartbeat();

    expect(result.items_queued).toBe(2);
    expect(mockWriteAgentMemory).toHaveBeenCalledWith(
      'altus',
      'altus:heartbeat:review_queue',
      expect.stringContaining('Refresh Deftones opportunity'),
    );
  });
});
