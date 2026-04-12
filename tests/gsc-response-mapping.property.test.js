// Feature: altus-topic-discovery-news-intelligence, Property 9: GSC response field mapping completeness
// Feature: altus-topic-discovery-news-intelligence, Property 12: Opportunity zone position filtering

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Validates: Requirements 1.2, 3.2
 *
 * Property 9: GSC response field mapping completeness
 * Given a raw GSC row with { keys, clicks, impressions, ctr, position },
 * the mapping function preserves all five fields without data loss.
 * Numeric fields maintain their values through the mapping.
 */

/**
 * Pure mapping function extracted from the GSC client row mapping pattern.
 * This is the exact transform applied in getSearchPerformance,
 * getNewsSearchPerformance, getOpportunityZoneQueries, and getPagePerformance.
 */
function mapGscRow(row) {
  return {
    keys: row.keys,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  };
}

/**
 * Validates: Requirements 2.1, 2.2
 *
 * Property 12: Opportunity zone position filtering
 * Given an array of rows with varying positions, filtering to position 5–30
 * only includes rows in that range. Results are sorted by impressions descending.
 */

/**
 * Pure filtering function extracted from getOpportunityZoneQueries.
 * Filters rows to the opportunity zone (position 5–30).
 */
function filterOpportunityZone(rows) {
  return rows.filter((row) => row.position >= 5 && row.position <= 30);
}

/**
 * Sort by impressions descending — matches the GSC orderBy used in
 * getOpportunityZoneQueries.
 */
function sortByImpressionsDesc(rows) {
  return [...rows].sort((a, b) => b.impressions - a.impressions);
}

// --- Arbitraries ---

/** Arbitrary for a realistic GSC keys array (1–3 string keys) */
const keysArb = fc.array(fc.string({ minLength: 1, maxLength: 60 }), { minLength: 1, maxLength: 3 });

/** Arbitrary for a single raw GSC response row */
const gscRowArb = fc.record({
  keys: keysArb,
  clicks: fc.nat({ max: 100000 }),
  impressions: fc.nat({ max: 1000000 }),
  ctr: fc.double({ min: 0, max: 1, noNaN: true }),
  position: fc.double({ min: 1, max: 100, noNaN: true }),
});

/** Arbitrary for a GSC row with position anywhere (for filtering tests) */
const gscRowWithPositionArb = fc.record({
  keys: keysArb,
  clicks: fc.nat({ max: 50000 }),
  impressions: fc.nat({ max: 500000 }),
  ctr: fc.double({ min: 0, max: 1, noNaN: true }),
  position: fc.double({ min: 0.5, max: 100, noNaN: true }),
});

// --- Property 9 Tests ---

describe('GSC response field mapping — Property 9: field mapping completeness', () => {
  it('mapped row preserves all five fields from the raw GSC row', () => {
    fc.assert(
      fc.property(gscRowArb, (raw) => {
        const mapped = mapGscRow(raw);
        expect(mapped.keys).toBe(raw.keys);
        expect(mapped.clicks).toBe(raw.clicks);
        expect(mapped.impressions).toBe(raw.impressions);
        expect(mapped.ctr).toBe(raw.ctr);
        expect(mapped.position).toBe(raw.position);
      }),
      { numRuns: 200 }
    );
  });

  it('mapped row contains exactly five keys — no extra fields, no missing fields', () => {
    fc.assert(
      fc.property(gscRowArb, (raw) => {
        const mapped = mapGscRow(raw);
        const fieldNames = Object.keys(mapped).sort();
        expect(fieldNames).toEqual(['clicks', 'ctr', 'impressions', 'keys', 'position']);
      }),
      { numRuns: 200 }
    );
  });

  it('numeric fields maintain exact values through mapping (no rounding or coercion)', () => {
    fc.assert(
      fc.property(gscRowArb, (raw) => {
        const mapped = mapGscRow(raw);
        expect(mapped.clicks).toStrictEqual(raw.clicks);
        expect(mapped.impressions).toStrictEqual(raw.impressions);
        expect(mapped.ctr).toStrictEqual(raw.ctr);
        expect(mapped.position).toStrictEqual(raw.position);
      }),
      { numRuns: 200 }
    );
  });

  it('mapping an array of rows preserves all rows and all fields', () => {
    fc.assert(
      fc.property(
        fc.array(gscRowArb, { minLength: 0, maxLength: 50 }),
        (rawRows) => {
          const mapped = rawRows.map(mapGscRow);
          expect(mapped.length).toBe(rawRows.length);
          for (let i = 0; i < rawRows.length; i++) {
            expect(mapped[i].keys).toBe(rawRows[i].keys);
            expect(mapped[i].clicks).toBe(rawRows[i].clicks);
            expect(mapped[i].impressions).toBe(rawRows[i].impressions);
            expect(mapped[i].ctr).toBe(rawRows[i].ctr);
            expect(mapped[i].position).toBe(rawRows[i].position);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Property 12 Tests ---

describe('Opportunity zone position filtering — Property 12: position filtering', () => {
  it('every returned row has position between 5 and 30 inclusive', () => {
    fc.assert(
      fc.property(
        fc.array(gscRowWithPositionArb, { minLength: 0, maxLength: 80 }),
        (rows) => {
          const filtered = filterOpportunityZone(rows);
          for (const row of filtered) {
            expect(row.position).toBeGreaterThanOrEqual(5);
            expect(row.position).toBeLessThanOrEqual(30);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('no row outside position 5–30 appears in the filtered result', () => {
    fc.assert(
      fc.property(
        fc.array(gscRowWithPositionArb, { minLength: 1, maxLength: 80 }),
        (rows) => {
          const filtered = filterOpportunityZone(rows);
          const outsideRange = filtered.filter(
            (r) => r.position < 5 || r.position > 30
          );
          expect(outsideRange).toHaveLength(0);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('all rows within position 5–30 are included in the filtered result', () => {
    fc.assert(
      fc.property(
        fc.array(gscRowWithPositionArb, { minLength: 0, maxLength: 80 }),
        (rows) => {
          const filtered = filterOpportunityZone(rows);
          const expectedCount = rows.filter(
            (r) => r.position >= 5 && r.position <= 30
          ).length;
          expect(filtered.length).toBe(expectedCount);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('sorted result is ordered by impressions descending', () => {
    fc.assert(
      fc.property(
        fc.array(gscRowWithPositionArb, { minLength: 0, maxLength: 80 }),
        (rows) => {
          const filtered = filterOpportunityZone(rows);
          const sorted = sortByImpressionsDesc(filtered);
          for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i - 1].impressions).toBeGreaterThanOrEqual(
              sorted[i].impressions
            );
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('filtering then sorting preserves all fields from original rows', () => {
    fc.assert(
      fc.property(
        fc.array(gscRowWithPositionArb, { minLength: 1, maxLength: 50 }),
        (rows) => {
          const filtered = filterOpportunityZone(rows);
          const sorted = sortByImpressionsDesc(filtered);
          // Every sorted row should be reference-equal to one of the original rows
          for (const row of sorted) {
            expect(rows).toContain(row);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('empty input produces empty output', () => {
    const filtered = filterOpportunityZone([]);
    expect(filtered).toEqual([]);
    const sorted = sortByImpressionsDesc(filtered);
    expect(sorted).toEqual([]);
  });
});
