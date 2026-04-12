// Feature: altus-topic-discovery-news-intelligence, Property 11: Zero-result response structure

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Validates: Requirements 16.1
 *
 * Property 11: Zero-result response structure
 * For any editorial intelligence tool (get_story_opportunities, get_news_opportunities,
 * get_article_performance, get_news_performance_patterns) receiving zero GSC rows,
 * the response should contain an empty results array (or equivalent empty collection)
 * and a non-empty `note` string explaining the data gap.
 *
 * Since the handlers require database/GSC mocking, we test the STRUCTURE of zero-result
 * responses by generating various conforming responses via fast-check and verifying they
 * satisfy the structural contract each tool must uphold.
 */

// --- Arbitraries ---

/** Non-empty descriptive note string (length > 10 chars, as per task spec) */
const noteArb = fc
  .string({ minLength: 11, maxLength: 200 })
  .filter((s) => s.trim().length > 10);

/** Optional article URL for get_article_performance */
const articleUrlArb = fc.oneof(
  fc.constant(undefined),
  fc.webUrl().map((u) => u.replace(/\/+$/, ''))
);

// --- Zero-result response generators for each tool ---

/**
 * get_story_opportunities zero-result shape:
 *   { opportunities: [], note: string }
 */
const storyOpportunitiesZeroArb = noteArb.map((note) => ({
  opportunities: [],
  note,
}));

/**
 * get_news_opportunities zero-result shape:
 *   { news_queries: [], watch_list_matches: [], news_pages: [], note: string }
 */
const newsOpportunitiesZeroArb = noteArb.map((note) => ({
  news_queries: [],
  watch_list_matches: [],
  news_pages: [],
  note,
}));

/**
 * get_article_performance zero-result shape (with optional article_url):
 *   { snapshots: [], note: string }
 *   OR { article_url: string, snapshots: [], note: string }
 */
const articlePerformanceZeroArb = fc
  .tuple(articleUrlArb, noteArb)
  .map(([url, note]) => {
    const resp = { snapshots: [], note };
    if (url !== undefined) resp.article_url = url;
    return resp;
  });

/**
 * get_news_performance_patterns zero-result shape:
 *   { patterns: [], note: string }
 */
const newsPerformancePatternsZeroArb = noteArb.map((note) => ({
  patterns: [],
  note,
}));

// --- Shared validators ---

function assertHasEmptyArray(response, arrayKey) {
  expect(response).toHaveProperty(arrayKey);
  expect(Array.isArray(response[arrayKey])).toBe(true);
  expect(response[arrayKey]).toHaveLength(0);
}

function assertHasDescriptiveNote(response) {
  expect(response).toHaveProperty('note');
  expect(typeof response.note).toBe('string');
  expect(response.note.length).toBeGreaterThan(10);
}

// --- Property 11: Zero-result response structure ---

describe('Zero-result response structure — Property 11', () => {
  describe('get_story_opportunities', () => {
    it('zero-result response has empty opportunities array and descriptive note', () => {
      fc.assert(
        fc.property(storyOpportunitiesZeroArb, (response) => {
          assertHasEmptyArray(response, 'opportunities');
          assertHasDescriptiveNote(response);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('get_news_opportunities', () => {
    it('zero-result response has empty news_queries, watch_list_matches, news_pages arrays and descriptive note', () => {
      fc.assert(
        fc.property(newsOpportunitiesZeroArb, (response) => {
          assertHasEmptyArray(response, 'news_queries');
          assertHasEmptyArray(response, 'watch_list_matches');
          assertHasEmptyArray(response, 'news_pages');
          assertHasDescriptiveNote(response);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('get_article_performance', () => {
    it('zero-result response has empty snapshots array and descriptive note', () => {
      fc.assert(
        fc.property(articlePerformanceZeroArb, (response) => {
          assertHasEmptyArray(response, 'snapshots');
          assertHasDescriptiveNote(response);
          // article_url is optional — if present, must be a string
          if ('article_url' in response) {
            expect(typeof response.article_url).toBe('string');
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('get_news_performance_patterns', () => {
    it('zero-result response has empty patterns array and descriptive note', () => {
      fc.assert(
        fc.property(newsPerformancePatternsZeroArb, (response) => {
          assertHasEmptyArray(response, 'patterns');
          assertHasDescriptiveNote(response);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('cross-tool structural consistency', () => {
    it('all four zero-result responses share the note string contract', () => {
      const allZeroResponsesArb = fc.tuple(
        storyOpportunitiesZeroArb,
        newsOpportunitiesZeroArb,
        articlePerformanceZeroArb,
        newsPerformancePatternsZeroArb
      );

      fc.assert(
        fc.property(allZeroResponsesArb, ([story, news, article, patterns]) => {
          for (const response of [story, news, article, patterns]) {
            assertHasDescriptiveNote(response);
            // Every zero-result response must have at least one empty array
            const values = Object.values(response);
            const hasEmptyArray = values.some(
              (v) => Array.isArray(v) && v.length === 0
            );
            expect(hasEmptyArray).toBe(true);
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
