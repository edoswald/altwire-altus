/**
 * review-scoring.js
 *
 * Shared review-scoring logic for the AltWire review corpus.
 * Used by scripts/score-reviews.js (direct + batch modes) so prompt building,
 * parsing, and request construction cannot drift between the two paths.
 *
 * The system prompt is static across every review, so both modes ship it as a
 * cached block (cache_control: ephemeral) — inside a batch the first request
 * writes it and later requests read it back on a best-effort basis.
 */

import Anthropic from '@anthropic-ai/sdk';
import { withCachedSystem } from './anthropic-cache.js';
import { submitBatch, waitForBatch, logBatchUsage } from '../batch-client.js';
import { logger } from '../logger.js';

export const MODEL = 'claude-haiku-4-5-20251001';
export const MAX_PROS_CONS = 5;
export const REVIEW_BATCH_SUBMIT_SIZE = 500;

const anthropic = new Anthropic(); // uses ANTHROPIC_API_KEY from env

/**
 * Static, cacheable system prompt for review scoring. Identical for every
 * review in a run, so Anthropic caches it after the first write and each
 * later review only bills the dynamic user content.
 */
export function buildReviewSystemPrompt() {
  const typeDescriptions = [
    'hardware  — physical music gear: instruments, amps, pedals, synths, drum machines, hardware samplers, etc.',
    'software  — DAWs, plugins, virtual instruments, mobile apps, desktop music software',
    'recording — audio interfaces, studio monitors, microphones, preamps, studio outboard gear',
    'live      — PA systems, live mixing consoles, IEMs, stage monitors, live sound equipment',
    'accessory — cables, cases, strings, picks, straps, stands, tuners, non-electronic accessories',
    'service   — music streaming services, lesson platforms, repair services, software subscriptions',
    'album     — reviews of full-length albums or EPs (multiple tracks evaluated as a body of work)',
    'single    — reviews of a single song or track release',
    'other     — anything that does not clearly fit the above',
  ].join('\n');

  return `You are analyzing an AltWire music publication review article. Read the full text carefully before responding.

---

INSTRUCTIONS:

Step 1 — Content classification
Is this a product/service review OR a concert/live performance review?
If it is a concert or live performance review, return ONLY: {"type": "concert"}

Step 2 — Product type (product/service reviews only)
Classify the reviewed item as exactly one of these product types based on the review content — NOT the WP categories:

${typeDescriptions}

Step 3 — Categorization check
If the product type you detected does NOT match what the WP categories suggest, note it briefly.
If the WP categories seem correct or there is no subcategory listed, set categorization_issue to null.

Step 4 — Ratings
Use the subcategories that correspond to the product type you identified:
  hardware:    Sound, Build, Workflow, Effects, Value
  software:    Sound, Interface, Workflow, Features, Value
  recording:   Sound, Build, Workflow, Features, Value
  live:        Sound, Build, Reliability, Workflow, Value
  accessory:   Build, Compatibility, Durability, Design, Value
  service:     Features, Interface, Reliability, Support, Value
  album:       Sound, Production, Songwriting, Cohesion, Value
  single:      Sound, Production, Songwriting, Impact, Value
  other:       Sound, Build, Workflow, Effects, Value

Rate each subcategory 1–10 based strictly on what the review text says:
  1–5: Poor to mediocre | 6–7: Average to good | 8–9: Great | 10: Exceptional

Step 5 — Pros and cons
Extract pros and cons ONLY from points explicitly made in the review text. Do not invent.
HARD LIMIT: maximum ${MAX_PROS_CONS} pros and maximum ${MAX_PROS_CONS} cons.
Fewer is better for short reviews — do not pad. Aim for quality, not quantity.
Balance the count to reflect the overall tone:
  avg ≥ 8.0 → more pros than cons
  avg 6.0–7.9 → roughly balanced (within 1)
  avg ≤ 5.9 → more cons than pros

Step 6 — Copy issues
Note any clear spelling errors, grammatical mistakes, or formatting problems. Be brief and specific.
Return an empty array if none found.

---

Return ONLY a valid JSON object, no markdown fences, no explanation outside the JSON:

{
  "type": "product",
  "product_type": "<one of: hardware|software|recording|live|accessory|service|album|single|other>",
  "categorization_issue": "<string describing mismatch, or null>",
  "pros": ["...", ...],
  "cons": ["...", ...],
  "ratings": {
    "<subcategory1>": <1-10>,
    "<subcategory2>": <1-10>,
    "<subcategory3>": <1-10>,
    "<subcategory4>": <1-10>,
    "<subcategory5>": <1-10>
  },
  "copy_issues": ["...", ...]
}`;
}

/**
 * Build the dynamic user message for review scoring — title, categories, and
 * the (truncated) review body. Everything static lives in buildReviewSystemPrompt().
 */
export function buildReviewPrompt(review) {
  const bodyText = review.raw_text.length > 6000
    ? review.raw_text.slice(0, 6000) + '\n\n[...truncated for analysis...]'
    : review.raw_text;

  return `TITLE: ${review.title}
WP CATEGORIES: ${(review.categories ?? []).join(', ')}

REVIEW TEXT:
${bodyText}`;
}

export function capArray(arr, max) {
  return Array.isArray(arr) ? arr.slice(0, max) : [];
}

/**
 * Parse a raw model response into a scored-review object.
 * Throws when no JSON object is present in the text.
 */
export function parseScoreText(raw) {
  const text = raw ?? '{}';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in response');
  const result = JSON.parse(match[0]);

  // Enforce hard cap on pros/cons regardless of what the model returned
  if (result.pros) result.pros = capArray(result.pros, MAX_PROS_CONS);
  if (result.cons) result.cons = capArray(result.cons, MAX_PROS_CONS);

  return result;
}

/**
 * Build the Anthropic Batch request objects for a set of reviews.
 * custom_id is the wp_id (unique per review in the corpus).
 */
export function buildReviewBatchRequests(reviews) {
  return reviews.map((review) => ({
    custom_id: String(review.wp_id),
    params: {
      model: MODEL,
      max_tokens: 1500,
      system: withCachedSystem(buildReviewSystemPrompt()),
      messages: [{ role: 'user', content: buildReviewPrompt(review) }],
    },
  }));
}

/**
 * Score reviews through the Anthropic Batch API (50% discount). Requests are
 * submitted in chunks; each chunk is awaited inline. Returns a Map from
 * custom_id → { parsed, error } where parsed is the scored-review object.
 *
 * @param {Array<{ custom_id: string, params: object }>} requests
 * @param {{ submitSize?: number }} [opts]
 * @returns {Promise<Map<string, { parsed: object|null, error: string|null }>>}
 */
export async function scoreReviewsInBatch(requests, { submitSize = REVIEW_BATCH_SUBMIT_SIZE } = {}) {
  const results = new Map();
  if (!requests.length) return results;

  for (let i = 0; i < requests.length; i += submitSize) {
    const chunk = requests.slice(i, i + submitSize);

    let batchResults;
    try {
      const batchId = await submitBatch(chunk);
      logger.info('Review scoring batch submitted', { batch_id: batchId, requests: chunk.length });
      batchResults = await waitForBatch(batchId);
      await logBatchUsage(batchId, batchResults, 'score_reviews');
    } catch (err) {
      logger.error('Review scoring batch failed', { error: err.message, requests: chunk.length });
      for (const req of chunk) {
        results.set(req.custom_id, { parsed: null, error: err.message });
      }
      continue;
    }

    const byId = new Map(batchResults.map((r) => [r.custom_id, r]));
    for (const req of chunk) {
      const item = byId.get(req.custom_id);
      if (item?.result?.type !== 'succeeded') {
        const failure = item?.result;
        const error = failure?.type === 'errored'
          ? (failure.error?.message ?? 'batch request errored')
          : `batch result type: ${failure?.type ?? 'missing'}`;
        results.set(req.custom_id, { parsed: null, error });
        continue;
      }
      const raw = item.result.message?.content?.find((b) => b.type === 'text')?.text;
      try {
        results.set(req.custom_id, { parsed: parseScoreText(raw), error: null });
      } catch (err) {
        results.set(req.custom_id, { parsed: null, error: err.message });
      }
    }
  }

  return results;
}