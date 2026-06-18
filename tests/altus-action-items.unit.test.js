import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { poolQueryMock, readAgentMemoryMock, writeAgentMemoryMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  readAgentMemoryMock: vi.fn(),
  writeAgentMemoryMock: vi.fn(),
}));

vi.mock('../lib/altus-db.js', () => ({
  default: {
    query: poolQueryMock,
    connect: vi.fn(),
  },
  readAgentMemory: (...args) => readAgentMemoryMock(...args),
  writeAgentMemory: (...args) => writeAgentMemoryMock(...args),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import pool from '../lib/altus-db.js';
import { listActionItems, manageActionItem } from '../handlers/altus-action-items.js';

describe('Altus action-item parity module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('returns not_found when manageActionItem cannot find an item', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await manageActionItem({ item_id: 999, action: 'accept' });

    expect(result.success).toBe(false);
    expect(result.exit_reason).toBe('not_found');
  });

  it('lists proposed items by default', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'proposed' }] });

    const result = await listActionItems();

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.items).toEqual([{ id: 1, status: 'proposed' }]);
  });

  it('records a win when a concrete action item is completed', async () => {
    readAgentMemoryMock.mockResolvedValue({ success: true, value: '[]' });
    writeAgentMemoryMock.mockResolvedValue({ success: true });
    pool.query.mockImplementation(async (sql) => {
      if (String(sql).startsWith('SELECT')) {
        return {
          rows: [{
            id: 44,
            status: 'accepted',
            title: 'Fix artist page SEO',
            category: 'editorial',
            signal_source: 'altus:story_opportunities',
          }],
        };
      }
      return {
        rows: [{
          id: 44,
          status: 'completed',
          title: 'Fix artist page SEO',
          category: 'editorial',
          signal_source: 'altus:story_opportunities',
          outcome_notes: 'Updated title, deck, and keyword framing for the article.',
        }],
      };
    });

    const result = await manageActionItem({
      item_id: 44,
      action: 'complete',
      outcome_notes: 'Updated title, deck, and keyword framing for the article.',
    });

    expect(result.success).toBe(true);
    expect(writeAgentMemoryMock).toHaveBeenCalledWith(
      'hal',
      'reflection:wins',
      expect.stringContaining('Fix artist page SEO'),
    );
  });
});
