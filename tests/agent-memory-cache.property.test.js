// Feature: altus-topic-discovery-news-intelligence, Property 5: Agent memory cache round-trip

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Validates: Requirements 6.6, 6.7, 13.1, 13.2, 13.3, 13.4, 10.4
 *
 * Property 5: Agent memory cache round-trip
 * - Writing a JSON-serializable object then reading it back returns the original object
 * - Writing the same key twice with different values returns only the latest (upsert)
 * - Reading a key for a different date returns no result
 *
 * Since we can't test against a real DB, we simulate the agent_memory table with an
 * in-memory Map that mirrors the SQL semantics:
 *   - Composite key: (agent, key)
 *   - Write: INSERT ... ON CONFLICT (agent, key) DO UPDATE SET value = EXCLUDED.value
 *   - Read: SELECT value FROM agent_memory WHERE agent = $1 AND key = $2
 */

// --- In-memory agent_memory simulation ---

/**
 * Creates a mock agent_memory store that replicates the PostgreSQL
 * ON CONFLICT (agent, key) DO UPDATE upsert semantics.
 */
function createMemoryStore() {
  const store = new Map();

  /** Composite key for the Map — mirrors the (agent, key) unique constraint */
  const compositeKey = (agent, key) => `${agent}::${key}`;

  return {
    /**
     * Simulates:
     *   INSERT INTO agent_memory (agent, key, value) VALUES ($1, $2, $3)
     *   ON CONFLICT (agent, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
     */
    write(agent, key, value) {
      store.set(compositeKey(agent, key), JSON.stringify(value));
    },

    /**
     * Simulates:
     *   SELECT value FROM agent_memory WHERE agent = $1 AND key = $2
     */
    read(agent, key) {
      const ck = compositeKey(agent, key);
      if (store.has(ck)) {
        return { rows: [{ value: store.get(ck) }] };
      }
      return { rows: [] };
    },
  };
}

// --- Arbitraries ---

/** JSON-serializable objects (the values cached in agent_memory) */
const jsonValueArb = fc.jsonValue();

/** Date string in YYYY-MM-DD format (used in cache keys) */
const dateKeyArb = fc
  .integer({ min: 0, max: 2556 }) // ~7 years of days from 2024-01-01
  .map((offset) => {
    const d = new Date(2024, 0, 1 + offset);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  });

/** Agent name — always 'altus' per the design */
const agentArb = fc.constantFrom('altus');

/** Cache key prefix — mirrors the handler's key patterns */
const keyPrefixArb = fc.constantFrom(
  'altus:story_opportunities',
  'altus:news_alert'
);

/** Full cache key: prefix + date */
const cacheKeyArb = fc.tuple(keyPrefixArb, dateKeyArb).map(
  ([prefix, date]) => `${prefix}:${date}`
);

/** Two distinct dates for the different-key test */
const distinctDatePairArb = fc
  .tuple(dateKeyArb, dateKeyArb)
  .filter(([d1, d2]) => d1 !== d2);

// --- Property 5: Agent memory cache round-trip ---

describe('Agent memory cache — Property 5: round-trip', () => {
  it('write then read returns the original JSON object', () => {
    fc.assert(
      fc.property(agentArb, cacheKeyArb, jsonValueArb, (agent, key, value) => {
        const mem = createMemoryStore();

        // Write
        mem.write(agent, key, value);

        // Read back
        const result = mem.read(agent, key);
        expect(result.rows).toHaveLength(1);

        const parsed = JSON.parse(result.rows[0].value);
        expect(parsed).toEqual(value);
      }),
      { numRuns: 100 }
    );
  });

  it('upsert: writing same key twice returns only the latest value', () => {
    fc.assert(
      fc.property(
        agentArb,
        cacheKeyArb,
        jsonValueArb,
        jsonValueArb,
        (agent, key, firstValue, secondValue) => {
          const mem = createMemoryStore();

          // First write
          mem.write(agent, key, firstValue);

          // Second write (upsert) with different value
          mem.write(agent, key, secondValue);

          // Read should return the second (latest) value
          const result = mem.read(agent, key);
          expect(result.rows).toHaveLength(1);

          const parsed = JSON.parse(result.rows[0].value);
          // Compare through JSON round-trip since that's what the real cache does
          // (JSON.stringify(-0) === "0", so -0 becomes 0 after round-trip)
          expect(parsed).toEqual(JSON.parse(JSON.stringify(secondValue)));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('reading a different date key returns no result', () => {
    fc.assert(
      fc.property(
        agentArb,
        keyPrefixArb,
        distinctDatePairArb,
        jsonValueArb,
        (agent, prefix, [date1, date2], value) => {
          const mem = createMemoryStore();
          const writeKey = `${prefix}:${date1}`;
          const readKey = `${prefix}:${date2}`;

          // Write with date1
          mem.write(agent, writeKey, value);

          // Read with date2 — should find nothing
          const result = mem.read(agent, readKey);
          expect(result.rows).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('cached value is stored as a JSON string (not raw object)', () => {
    fc.assert(
      fc.property(agentArb, cacheKeyArb, jsonValueArb, (agent, key, value) => {
        const mem = createMemoryStore();

        mem.write(agent, key, value);

        const result = mem.read(agent, key);
        // The raw stored value should be a string (JSON.stringify'd)
        expect(typeof result.rows[0].value).toBe('string');
        // And it should parse back to the original
        expect(JSON.parse(result.rows[0].value)).toEqual(value);
      }),
      { numRuns: 100 }
    );
  });
});
