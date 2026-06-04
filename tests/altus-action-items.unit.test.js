import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: {
    query: vi.fn(),
    connect: vi.fn(),
  },
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
});
