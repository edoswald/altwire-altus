// Feature: altus-topic-discovery-news-intelligence, Property 2: Opportunity scoring formula correctness
// Feature: altus-topic-discovery-news-intelligence, Property 3: Coverage gap classification threshold

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { scoreOpportunity, classifyCoverageGap } from '../handlers/altus-topic-discovery.js';

/**
 * Validates: Requirements 6.2, 6.3
 *
 * Property 2: Opportunity scoring formula correctness
 * - score = impressions * (1 - (position - 5) / 25) * gapMultiplier
 * - score is always non-negative when impressions >= 0 and 5 <= position <= 30
 * - higher impressions with same position and gap → higher or equal score (monotonic)
 *
 * Property 3: Coverage gap classification threshold
 * - weightedScore < 0.25 → { status: 'no_coverage', multiplier: 1.5 }
 * - 0.25 <= weightedScore < 0.50 → { status: 'weak_coverage', multiplier: 1.2 }
 * - weightedScore >= 0.50 → { status: 'covered', multiplier: 1.0 }
 * - multiplier is always one of {1.0, 1.2, 1.5}
 */

// --- Arbitraries ---

/** Impressions: non-negative integer */
const impressionsArb = fc.integer({ min: 0, max: 100_000 });

/** Position: float in the opportunity zone [5, 30] */
const positionArb = fc.double({ min: 5, max: 30, noNaN: true });

/** Gap multiplier: one of the three valid values */
const gapMultiplierArb = fc.constantFrom(1.0, 1.2, 1.5);

/** Weighted score: non-negative float for classification */
const weightedScoreArb = fc.double({ min: 0, max: 2, noNaN: true });

// --- Property 2: Opportunity scoring formula correctness ---

describe('scoreOpportunity — Property 2: formula correctness', () => {
  it('score equals impressions * (1 - (position - 5) / 25) * gapMultiplier for valid inputs', () => {
    fc.assert(
      fc.property(impressionsArb, positionArb, gapMultiplierArb, (impressions, position, gapMultiplier) => {
        const result = scoreOpportunity(impressions, position, gapMultiplier);
        const positionProximity = 1 - (position - 5) / 25;
        const expected = impressions * positionProximity * gapMultiplier;
        expect(result).toBeCloseTo(expected, 8);
      }),
      { numRuns: 100 }
    );
  });

  it('score is always non-negative when impressions >= 0 and 5 <= position <= 30', () => {
    fc.assert(
      fc.property(impressionsArb, positionArb, gapMultiplierArb, (impressions, position, gapMultiplier) => {
        const result = scoreOpportunity(impressions, position, gapMultiplier);
        expect(result).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 }
    );
  });

  it('higher impressions with same position and gap → higher or equal score (monotonic)', () => {
    fc.assert(
      fc.property(
        impressionsArb,
        impressionsArb,
        positionArb,
        gapMultiplierArb,
        (imp1, imp2, position, gapMultiplier) => {
          const low = Math.min(imp1, imp2);
          const high = Math.max(imp1, imp2);
          const scoreLow = scoreOpportunity(low, position, gapMultiplier);
          const scoreHigh = scoreOpportunity(high, position, gapMultiplier);
          expect(scoreHigh).toBeGreaterThanOrEqual(scoreLow);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Property 3: Coverage gap classification threshold ---

describe('classifyCoverageGap — Property 3: classification thresholds', () => {
  it('weightedScore < 0.25 → { status: "no_coverage", multiplier: 1.5 }', () => {
    const lowScoreArb = fc.double({ min: 0, max: 0.2499999, noNaN: true });
    fc.assert(
      fc.property(lowScoreArb, (weightedScore) => {
        const result = classifyCoverageGap(weightedScore);
        expect(result).toEqual({ status: 'no_coverage', multiplier: 1.5 });
      }),
      { numRuns: 100 }
    );
  });

  it('0.25 <= weightedScore < 0.50 → { status: "weak_coverage", multiplier: 1.2 }', () => {
    const midScoreArb = fc.double({ min: 0.25, max: 0.4999999, noNaN: true });
    fc.assert(
      fc.property(midScoreArb, (weightedScore) => {
        const result = classifyCoverageGap(weightedScore);
        expect(result).toEqual({ status: 'weak_coverage', multiplier: 1.2 });
      }),
      { numRuns: 100 }
    );
  });

  it('weightedScore >= 0.50 → { status: "covered", multiplier: 1.0 }', () => {
    const highScoreArb = fc.double({ min: 0.50, max: 10, noNaN: true });
    fc.assert(
      fc.property(highScoreArb, (weightedScore) => {
        const result = classifyCoverageGap(weightedScore);
        expect(result).toEqual({ status: 'covered', multiplier: 1.0 });
      }),
      { numRuns: 100 }
    );
  });

  it('multiplier is always one of {1.0, 1.2, 1.5}', () => {
    fc.assert(
      fc.property(weightedScoreArb, (weightedScore) => {
        const result = classifyCoverageGap(weightedScore);
        expect([1.0, 1.2, 1.5]).toContain(result.multiplier);
      }),
      { numRuns: 100 }
    );
  });
});
