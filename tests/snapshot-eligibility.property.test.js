// Feature: altus-topic-discovery-news-intelligence, Property 6: Snapshot eligibility date arithmetic

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { getSnapshotEligibility } from '../handlers/altus-performance-tracker.js';

/**
 * Validates: Requirements 11.2, 11.4
 *
 * Property 6: Snapshot eligibility date arithmetic
 * - Article published 4+ days before effectiveDate with no existing snapshots → includes '72h'
 * - Article published 8+ days before effectiveDate with no existing snapshots → includes '72h' and '7d'
 * - Article published 31+ days before effectiveDate with no existing snapshots → includes all three
 * - Article published recently (< 3 days before effectiveDate) → returns empty array
 * - Existing snapshots are excluded from the result
 * - Result only contains valid snapshot types ('72h', '7d', '30d')
 */

const VALID_SNAPSHOT_TYPES = ['72h', '7d', '30d'];

/**
 * Arbitrary: a fixed effectiveDate and a publishedAt that is `daysAgo` days before it.
 * We anchor effectiveDate to 2025-06-15 to keep dates deterministic.
 */
const baseEffective = new Date('2025-06-15T00:00:00Z');

/** Generate a number of days ago (0–60) for the publishedAt offset */
const daysAgoArb = fc.integer({ min: 0, max: 60 });

/** Generate a subset of existing snapshot types */
const existingSnapshotsArb = fc.subarray(VALID_SNAPSHOT_TYPES, { minLength: 0, maxLength: 3 });

/** Helper: create a publishedAt date that is `daysAgo` days before the effective date */
function publishedAtFromDaysAgo(daysAgo) {
  const d = new Date(baseEffective);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

describe('getSnapshotEligibility — Property 6: Snapshot eligibility date arithmetic', () => {
  it('article published 4+ days before effectiveDate with no existing snapshots → includes "72h"', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 60 }),
        (daysAgo) => {
          const publishedAt = publishedAtFromDaysAgo(daysAgo);
          const result = getSnapshotEligibility(publishedAt, [], baseEffective);
          expect(result).toContain('72h');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('article published 8+ days before effectiveDate with no existing snapshots → includes "72h" and "7d"', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 60 }),
        (daysAgo) => {
          const publishedAt = publishedAtFromDaysAgo(daysAgo);
          const result = getSnapshotEligibility(publishedAt, [], baseEffective);
          expect(result).toContain('72h');
          expect(result).toContain('7d');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('article published 31+ days before effectiveDate with no existing snapshots → includes all three', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 31, max: 60 }),
        (daysAgo) => {
          const publishedAt = publishedAtFromDaysAgo(daysAgo);
          const result = getSnapshotEligibility(publishedAt, [], baseEffective);
          expect(result).toEqual(expect.arrayContaining(['72h', '7d', '30d']));
          expect(result).toHaveLength(3);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('article published recently (< 3 days before effectiveDate) → returns empty array', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 }),
        (daysAgo) => {
          const publishedAt = publishedAtFromDaysAgo(daysAgo);
          const result = getSnapshotEligibility(publishedAt, [], baseEffective);
          expect(result).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('existing snapshots are excluded from the result', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 31, max: 60 }),
        existingSnapshotsArb.filter(arr => arr.length > 0),
        (daysAgo, existing) => {
          const publishedAt = publishedAtFromDaysAgo(daysAgo);
          const result = getSnapshotEligibility(publishedAt, existing, baseEffective);
          for (const snap of existing) {
            expect(result).not.toContain(snap);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('result only contains valid snapshot types ("72h", "7d", "30d")', () => {
    fc.assert(
      fc.property(
        daysAgoArb,
        existingSnapshotsArb,
        (daysAgo, existing) => {
          const publishedAt = publishedAtFromDaysAgo(daysAgo);
          const result = getSnapshotEligibility(publishedAt, existing, baseEffective);
          for (const snap of result) {
            expect(VALID_SNAPSHOT_TYPES).toContain(snap);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
