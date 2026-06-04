import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: { query: vi.fn() },
}));

import pool from '../lib/altus-db.js';
import { querySessionTraces } from '../handlers/altus-session-traces.js';

describe('Altus session trace parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('returns not_found for a missing session trace lookup', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await querySessionTraces({ session_id: 999 });

    expect(result.success).toBe(false);
    expect(result.exit_reason).toBe('not_found');
  });
});
