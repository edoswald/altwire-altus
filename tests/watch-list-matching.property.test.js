// Feature: altus-topic-discovery-news-intelligence, Property 4: Case-insensitive substring watch list matching

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { matchesWatchList } from '../handlers/altus-news-monitor.js';

/**
 * Validates: Requirements 7.2, 10.3
 *
 * Property 4: Case-insensitive substring watch list matching
 * - matchesWatchList returns item name when query contains item name (case-insensitive)
 * - matchesWatchList returns empty array when query does NOT contain item name
 * - Match result is identical regardless of original casing of either string
 * - Multiple watch items can match the same query
 * - Empty watch list always returns empty array
 */

// --- Arbitraries ---

/** Non-empty alphabetic string for watch item names (avoids regex-special chars) */
const nameArb = fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), { minLength: 2, maxLength: 15 })
  .map(chars => chars.join(''))
  .filter(s => s.trim().length > 0);

// --- Property tests ---

describe('matchesWatchList — Property 4: case-insensitive substring matching', () => {
  it('returns item name when query contains item name (case-insensitive)', () => {
    fc.assert(
      fc.property(
        nameArb,
        fc.string({ minLength: 0, maxLength: 30 }),
        fc.string({ minLength: 0, maxLength: 30 }),
        (itemName, prefix, suffix) => {
          // Build a query that definitely contains the item name
          const query = prefix + itemName + suffix;
          const watchItems = [{ name: itemName }];
          const result = matchesWatchList(query, watchItems);
          expect(result).toContain(itemName);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns empty array when query does NOT contain item name', () => {
    // Use two distinct names where neither is a substring of the other
    fc.assert(
      fc.property(
        fc.constant('alpha'),
        fc.constant('beta'),
        () => {
          const query = 'alpha query string';
          const watchItems = [{ name: 'beta' }];
          const result = matchesWatchList(query, watchItems);
          expect(result).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );

    // More general: generate disjoint strings
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999 }),
        (n) => {
          // Use numeric strings that can't be substrings of each other
          const query = `aaa${n}aaa`;
          const watchItems = [{ name: `zzz${n + 1000}zzz` }];
          const result = matchesWatchList(query, watchItems);
          expect(result).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('match result is identical regardless of original casing of either string', () => {
    fc.assert(
      fc.property(
        nameArb,
        fc.string({ minLength: 0, maxLength: 20 }),
        fc.string({ minLength: 0, maxLength: 20 }),
        fc.boolean(),
        fc.boolean(),
        (itemName, prefix, suffix, upperQuery, upperItem) => {
          const baseQuery = prefix + itemName + suffix;

          // Apply different casings
          const query1 = baseQuery.toLowerCase();
          const query2 = baseQuery.toUpperCase();
          const item1 = { name: itemName.toLowerCase() };
          const item2 = { name: itemName.toUpperCase() };
          const itemMixed = { name: upperItem ? itemName.toUpperCase() : itemName.toLowerCase() };

          // All combinations should match (query contains item as substring)
          const r1 = matchesWatchList(query1, [item1]);
          const r2 = matchesWatchList(query2, [item2]);
          const r3 = matchesWatchList(query1, [item2]);
          const r4 = matchesWatchList(query2, [item1]);

          // All should find a match (length > 0)
          expect(r1.length).toBeGreaterThan(0);
          expect(r2.length).toBeGreaterThan(0);
          expect(r3.length).toBeGreaterThan(0);
          expect(r4.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('multiple watch items can match the same query', () => {
    fc.assert(
      fc.property(
        nameArb,
        nameArb,
        (name1, name2) => {
          // Build a query containing both names
          const query = `${name1} and ${name2} news`;
          const watchItems = [{ name: name1 }, { name: name2 }];
          const result = matchesWatchList(query, watchItems);

          // Both should be found (they're both substrings of the query)
          expect(result).toContain(name1);
          expect(result).toContain(name2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('empty watch list always returns empty array', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100 }),
        (query) => {
          const result = matchesWatchList(query, []);
          expect(result).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });
});
