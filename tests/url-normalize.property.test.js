// Feature: altus-topic-discovery-news-intelligence, Property 1: URL normalization idempotence and equivalence

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { normalizeUrl } from '../handlers/altwire-gsc-client.js';

/**
 * Validates: Requirements 3.3, 8.4, 12.4, 15.1, 15.2
 *
 * Property 1: URL normalization idempotence and equivalence
 * - normalizeUrl(url) never ends with '/'
 * - normalizeUrl(url + '/') === normalizeUrl(url) (equivalence)
 * - normalizeUrl(normalizeUrl(url)) === normalizeUrl(url) (idempotence)
 * - Non-string inputs returned as-is
 */

/** Arbitrary that produces realistic URL-like strings */
const urlArb = fc.oneof(
  // Full URLs with optional trailing slashes
  fc.tuple(
    fc.constantFrom('http://', 'https://'),
    fc.webUrl().map(u => u.replace(/^https?:\/\//, '')),
    fc.constantFrom('', '/', '//', '///')
  ).map(([proto, path, trail]) => `${proto}${path}${trail}`),
  // Bare paths with optional trailing slashes
  fc.tuple(
    fc.string({ minLength: 1, maxLength: 80 }).filter(s => s.length > 0),
    fc.constantFrom('', '/', '//')
  ).map(([base, trail]) => `${base}${trail}`),
  // Edge: just slashes
  fc.constantFrom('/', '//', '///', 'https://example.com/', 'https://example.com')
);

describe('normalizeUrl — Property 1: idempotence and equivalence', () => {
  it('result never ends with "/" for any URL string', () => {
    fc.assert(
      fc.property(urlArb, (url) => {
        const result = normalizeUrl(url);
        // Only check non-empty results — an all-slash input normalizes to ''
        if (result.length > 0) {
          expect(result.endsWith('/')).toBe(false);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('normalizeUrl(url + "/") === normalizeUrl(url) (trailing slash equivalence)', () => {
    fc.assert(
      fc.property(urlArb, (url) => {
        expect(normalizeUrl(url + '/')).toBe(normalizeUrl(url));
      }),
      { numRuns: 200 }
    );
  });

  it('normalizeUrl(normalizeUrl(url)) === normalizeUrl(url) (idempotence)', () => {
    fc.assert(
      fc.property(urlArb, (url) => {
        const once = normalizeUrl(url);
        const twice = normalizeUrl(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 200 }
    );
  });

  it('non-string inputs are returned as-is', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.constant(null),
          fc.constant(undefined),
          fc.boolean(),
          fc.array(fc.integer()),
          fc.dictionary(fc.string(), fc.integer())
        ),
        (input) => {
          expect(normalizeUrl(input)).toBe(input);
        }
      ),
      { numRuns: 100 }
    );
  });
});
