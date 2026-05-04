/**
 * lib/editorial-helpers.js
 *
 * Shared editorial context loading and scoring utilities for AltWire
 * news intelligence and topic discovery handlers.
 *
 * Used by: handlers/altus-news-monitor.js, handlers/altus-topic-discovery.js,
 * handlers/altus-digest.js
 */

const EDITORIAL_CONTEXT_KEY = 'hal:altwire:editorial_context';
const TOPIC_TRENDS_KEY = 'hal:altwire:analytics:topic_trends';

export async function loadEditorialContext(readAgentMemoryFn) {
  try {
    const raw = await readAgentMemoryFn('hal', EDITORIAL_CONTEXT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

/**
 * Load topic_trends from agent_memory for editorial affinity scoring.
 * Rising topics get a higher weight boost in scoring.
 * @param {Function} readAgentMemoryFn
 * @returns {Promise<{rising: string[], stable: string[], declining: string[]}|null>}
 */
export async function loadTopicTrends(readAgentMemoryFn) {
  try {
    const raw = await readAgentMemoryFn('hal', TOPIC_TRENDS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      rising: parsed.rising_topics?.map((t) => t.topic) ?? [],
      stable: parsed.stable_topics?.map((t) => t.topic) ?? [],
      declining: parsed.declining_topics?.map((t) => t.topic) ?? [],
    };
  } catch { return null; }
}

export function scoreEditorialAffinity(query, editorialContext, topicTrends = null) {
  if (!query) {
    return { affinity: 0, matchType: null };
  }

  const lowerQuery = query.toLowerCase();
  let best = { affinity: 0, matchType: null };

  // First: check editorial_context subjects (genre/angle/theme)
  if (editorialContext?.subjects) {
    const { top_genres = [], common_angles = [], recurring_themes = [] } = editorialContext.subjects;
    const checks = [
      { list: top_genres, weight: 1.0, type: 'genre' },
      { list: common_angles, weight: 0.8, type: 'angle' },
      { list: recurring_themes, weight: 0.6, type: 'theme' },
    ];

    for (const { list, weight, type } of checks) {
      for (const term of list) {
        if (typeof term !== 'string') continue;
        if (lowerQuery.includes(term.toLowerCase())) {
          if (weight > best.affinity) {
            best = { affinity: weight, matchType: type };
          }
          break;
        }
      }
    }
  }

  // Second: boost by topic trends — rising topics get +0.3 affinity bonus
  if (topicTrends?.rising?.length) {
    for (const topic of topicTrends.rising) {
      if (lowerQuery.includes(topic.toLowerCase())) {
        if (best.affinity > 0) {
          best = { affinity: best.affinity + 0.3, matchType: best.matchType + '+rising_topic' };
        } else {
          best = { affinity: 0.5, matchType: 'rising_topic' };
        }
        break;
      }
    }
  }

  return best;
}