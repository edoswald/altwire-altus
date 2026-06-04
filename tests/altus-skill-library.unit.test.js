import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: { query: vi.fn() },
}));

import pool from '../lib/altus-db.js';
import { searchSkills } from '../handlers/altus-skill-library.js';

describe('Altus skill library parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('returns config_error when the database is unavailable', async () => {
    delete process.env.DATABASE_URL;

    const result = await searchSkills({ query: 'seo' });

    expect(result.success).toBe(false);
    expect(result.exit_reason).toBe('config_error');
  });

  it('returns rows from the local skill library', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ name: 'seo-brief', title: 'SEO Brief' }] });

    const result = await searchSkills({ query: 'seo' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.skills).toEqual([{ name: 'seo-brief', title: 'SEO Brief' }]);
  });
});
