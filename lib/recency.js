/**
 * Time decay weighting for search results.
 * Newer content scores closer to the raw similarity; older content is penalized.
 *
 * decay_weight = 1 / (1 + DECAY_RATE * age_years)
 * weighted_score = similarity * decay_weight
 */

const DECAY_RATE = 0.15;
const GALLERY_FALLBACK_AGE_YEARS = 3;

/**
 * @param {number} similarity - raw cosine similarity (0-1)
 * @param {string|null} publishedAt - ISO date string or null
 * @returns {number} recency-weighted score (0-1)
 */
export function applyRecencyWeight(similarity, publishedAt) {
  let ageYears;

  if (!publishedAt) {
    ageYears = GALLERY_FALLBACK_AGE_YEARS;
  } else {
    const ageMs = Date.now() - new Date(publishedAt).getTime();
    ageYears = Math.max(0, ageMs / (1000 * 60 * 60 * 24 * 365.25));
  }

  const decayWeight = 1 / (1 + DECAY_RATE * ageYears);
  return parseFloat((similarity * decayWeight).toFixed(6));
}
