// Feature: altus-topic-discovery-news-intelligence, Property 13: Article performance unique constraint enforcement

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Validates: Requirements 4.2
 *
 * Property 13: Article performance unique constraint enforcement
 * - Same (article_url, snapshot_type) pair → upsert overwrites, only one row exists
 * - Different snapshot_types for same article_url → all coexist (no conflict)
 * - Same snapshot_type for different article_urls → all coexist (no conflict)
 *
 * Simulates the UNIQUE(article_url, snapshot_type) constraint with an in-memory Map:
 *   Key: `${article_url}::${snapshot_type}`
 *   Insert: if key exists, upsert (overwrite); if not, insert
 */

// --- In-memory altus_article_performance simulation ---

/**
 * Creates a mock performance store that replicates the PostgreSQL
 * UNIQUE(article_url, snapshot_type) + ON CONFLICT DO UPDATE upsert semantics.
 */
function createPerformanceStore() {
  const store = new Map();

  /** Composite key mirrors the UNIQUE(article_url, snapshot_type) constraint */
  const compositeKey = (articleUrl, snapshotType) => `${articleUrl}::${snapshotType}`;

  return {
    /**
     * Simulates:
     *   INSERT INTO altus_article_performance (article_url, snapshot_type, clicks, impressions, ...)
     *   VALUES ($1, $2, $3, $4, ...)
     *   ON CONFLICT (article_url, snapshot_type) DO UPDATE SET
     *     clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ...
     */
    upsert(articleUrl, snapshotType, data) {
      store.set(compositeKey(articleUrl, snapshotType), { article_url: articleUrl, snapshot_type: snapshotType, ...data });
    },

    /**
     * Simulates:
     *   SELECT * FROM altus_article_performance WHERE article_url = $1
     */
    queryByUrl(articleUrl) {
      const rows = [];
      for (const row of store.values()) {
        if (row.article_url === articleUrl) rows.push(row);
      }
      return rows;
    },

    /**
     * Simulates:
     *   SELECT * FROM altus_article_performance WHERE snapshot_type = $1
     */
    queryByType(snapshotType) {
      const rows = [];
      for (const row of store.values()) {
        if (row.snapshot_type === snapshotType) rows.push(row);
      }
      return rows;
    },

    /** Total row count */
    size() {
      return store.size;
    },
  };
}

// --- Arbitraries ---

/** Realistic article URLs */
const articleUrlArb = fc
  .tuple(
    fc.constantFrom('https://altwire.net/', 'https://altwire.net/reviews/', 'https://altwire.net/news/'),
    fc.stringMatching(/^[a-z0-9-]{3,30}$/)
  )
  .map(([prefix, slug]) => `${prefix}${slug}`);

/** Valid snapshot types per the schema */
const snapshotTypeArb = fc.constantFrom('72h', '7d', '30d');

/** Performance data payload */
const perfDataArb = fc.record({
  clicks: fc.integer({ min: 0, max: 10000 }),
  impressions: fc.integer({ min: 0, max: 100000 }),
  ctr: fc.double({ min: 0, max: 1, noNaN: true }),
  avg_position: fc.double({ min: 1, max: 100, noNaN: true }),
});

/** Two distinct snapshot types */
const distinctSnapshotTypesPairArb = fc
  .tuple(snapshotTypeArb, snapshotTypeArb)
  .filter(([a, b]) => a !== b);

/** Two distinct article URLs */
const distinctUrlPairArb = fc
  .tuple(articleUrlArb, articleUrlArb)
  .filter(([a, b]) => a !== b);

// --- Property 13: Article performance unique constraint enforcement ---

describe('Article performance unique constraint — Property 13', () => {
  it('same (article_url, snapshot_type) pair → upsert overwrites, only one row exists', () => {
    fc.assert(
      fc.property(
        articleUrlArb,
        snapshotTypeArb,
        perfDataArb,
        perfDataArb,
        (url, type, firstData, secondData) => {
          const store = createPerformanceStore();

          // First insert
          store.upsert(url, type, firstData);
          expect(store.size()).toBe(1);

          // Second insert with same (url, type) — should upsert, not duplicate
          store.upsert(url, type, secondData);
          expect(store.size()).toBe(1);

          // The stored row should have the second data (overwritten)
          const rows = store.queryByUrl(url);
          expect(rows).toHaveLength(1);
          expect(rows[0].clicks).toBe(secondData.clicks);
          expect(rows[0].impressions).toBe(secondData.impressions);
          expect(rows[0].snapshot_type).toBe(type);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('different snapshot_types for same article_url → all coexist (no conflict)', () => {
    fc.assert(
      fc.property(
        articleUrlArb,
        distinctSnapshotTypesPairArb,
        perfDataArb,
        perfDataArb,
        (url, [type1, type2], data1, data2) => {
          const store = createPerformanceStore();

          store.upsert(url, type1, data1);
          store.upsert(url, type2, data2);

          // Both rows should exist — different snapshot_types don't conflict
          expect(store.size()).toBe(2);

          const rows = store.queryByUrl(url);
          expect(rows).toHaveLength(2);

          // Each row has its own snapshot_type and data
          const types = rows.map((r) => r.snapshot_type).sort();
          expect(types).toEqual([type1, type2].sort());
        }
      ),
      { numRuns: 100 }
    );
  });

  it('same snapshot_type for different article_urls → all coexist (no conflict)', () => {
    fc.assert(
      fc.property(
        distinctUrlPairArb,
        snapshotTypeArb,
        perfDataArb,
        perfDataArb,
        ([url1, url2], type, data1, data2) => {
          const store = createPerformanceStore();

          store.upsert(url1, type, data1);
          store.upsert(url2, type, data2);

          // Both rows should exist — different URLs don't conflict
          expect(store.size()).toBe(2);

          const byType = store.queryByType(type);
          expect(byType).toHaveLength(2);

          // Each row has its own URL
          const urls = byType.map((r) => r.article_url).sort();
          expect(urls).toEqual([url1, url2].sort());
        }
      ),
      { numRuns: 100 }
    );
  });
});
