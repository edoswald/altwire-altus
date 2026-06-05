import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: { query: vi.fn() },
  hasDbConfig: () => Boolean(process.env.ALTWIRE_DATABASE_URL || process.env.DATABASE_URL),
}));

import pool from '../lib/altus-db.js';
import {
  isAllowedDocumentKey,
  listDocuments,
  saveDocument,
} from '../handlers/altus-documents.js';

describe('Altus document helper parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('allows editorial workspace keys but excludes analytics payload keys', () => {
    expect(isAllowedDocumentKey('hal:altwire:editorial_context')).toBe(true);
    expect(isAllowedDocumentKey('reflection:2026-06-04')).toBe(true);
    expect(isAllowedDocumentKey('hal:altwire:analytics:traffic_summary')).toBe(false);
    expect(isAllowedDocumentKey('hal:soul')).toBe(false);
  });

  it('filters disallowed keys out of document listings', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { key: 'hal:altwire:editorial_context', value: 'Context body', updated_at: '2026-06-04T00:00:00.000Z' },
        { key: 'hal:altwire:analytics:traffic_summary', value: '{"visits":10}', updated_at: '2026-06-04T00:00:00.000Z' },
      ],
    });

    const result = await listDocuments();

    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('hal:altwire:editorial_context');
  });

  it('returns not_found when saving a missing document key', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await saveDocument('hal:altwire:headline_guidelines', 'Keep headlines sharp');

    expect(result.success).toBe(false);
    expect(result.error).toBe('not_found');
  });
});
