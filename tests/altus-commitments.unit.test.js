import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: { query: vi.fn() },
  hasDbConfig: () => Boolean(process.env.ALTWIRE_DATABASE_URL || process.env.DATABASE_URL),
}));

import pool from '../lib/altus-db.js';
import {
  recordCommitment,
  listCommitments,
  updateWatchItem,
} from '../handlers/altus-commitments.js';

describe('Altus commitments parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
    process.env.TEST_MODE = 'false';
    delete process.env.ALTWIRE_DATABASE_URL;
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.ALTWIRE_DATABASE_URL;
    delete process.env.TEST_MODE;
  });

  it('validates due_at for commitments', async () => {
    const result = await recordCommitment({
      title: 'Follow up with festival PR',
      due_at: 'not-a-date',
    });

    expect(result.success).toBe(false);
    expect(result.exit_reason).toBe('validation_error');
  });

  it('lists open commitments by default', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 4, title: 'Check headline guidelines', status: 'open' }],
    });

    const result = await listCommitments();

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.commitments[0].status).toBe('open');
  });

  it('accepts ALTWIRE_DATABASE_URL as sufficient database config', async () => {
    delete process.env.DATABASE_URL;
    process.env.ALTWIRE_DATABASE_URL = 'postgres://altwire-test';
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 5, title: 'Test AltWire-only DB guard', status: 'open' }],
    });

    const result = await listCommitments();

    expect(result.success).toBe(true);
    expect(pool.query).toHaveBeenCalled();
  });

  it('returns not_found when updating a missing watch item', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await updateWatchItem({
      watch_item_id: 42,
      status: 'resolved',
    });

    expect(result.success).toBe(false);
    expect(result.exit_reason).toBe('not_found');
  });
});
