/**
 * hal-harness.js — AltWire Altus session harness.
 *
 * Provides assembleSystemPrompt() with editorial context switching.
 * When agentContext === 'altwire', loads hal:soul:altwire and injects
 * AltWire-specific editorial context instead of the default e-commerce Hal soul.
 *
 * Note: This does NOT include runSession — that's nimbus-specific.
 * AltWire sessions are stateless HTTP requests via the MCP StreamableHTTP server.
 */

import pool from './lib/altus-db.js';

const SOUL_KEYS = {
  altwire: 'hal:soul:altwire',
  default: 'hal:soul',
};

const EDITORIAL_CONTEXT_KEY = 'hal:altwire:editorial_context';
const EDITORIAL_VOICE_KEY = 'hal:altwire:editorial_voice_profile';

const ANALYTICS_KEYS = {
  traffic_summary:      'hal:altwire:analytics:traffic_summary',
  top_articles_18m:    'hal:altwire:analytics:top_articles_18m',
  article_type_perf:   'hal:altwire:analytics:article_type_performance',
  topic_trends:        'hal:altwire:analytics:topic_trends',
  referrer_summary:    'hal:altwire:analytics:referrer_summary',
  search_keywords:      'hal:altwire:analytics:search_keywords_18m',
  seasonality:         'hal:altwire:analytics:seasonality',
  last_refreshed:      'hal:altwire:analytics:last_refreshed',
};

/**
 * Load the appropriate soul block for the given agent context.
 * @param {string|null} agentContext
 * @returns {Promise<string|null>}
 */
async function loadSoul(agentContext = null) {
  const key = agentContext === 'altwire' ? SOUL_KEYS.altwire : SOUL_KEYS.default;
  try {
    const result = await pool.query(
      `SELECT value FROM agent_memory WHERE agent = 'hal' AND key = $1 LIMIT 1`,
      [key]
    );
    return result.rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Load editorial context for AltWire sessions.
 * @returns {Promise<object|null>}
 */
async function loadEditorialContext() {
  try {
    const result = await pool.query(
      `SELECT value FROM agent_memory WHERE agent = 'hal' AND key = $1 LIMIT 1`,
      [EDITORIAL_CONTEXT_KEY]
    );
    if (result.rows[0]?.value) {
      return JSON.parse(result.rows[0].value);
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Load Derek's author profile for AI writer integration.
 * @returns {Promise<object|null>}
 */
async function loadDerekAuthorProfile() {
  try {
    const result = await pool.query(
      `SELECT value FROM agent_memory WHERE agent = 'hal' AND key = $1 LIMIT 1`,
      [EDITORIAL_VOICE_KEY]
    );
    if (result.rows[0]?.value) {
      return JSON.parse(result.rows[0].value);
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Load onboarding state for an admin.
 * @param {string} adminId
 * @returns {Promise<object|null>}
 */
async function loadOnboardingState(adminId) {
  try {
    const result = await pool.query(
      `SELECT value FROM agent_memory WHERE agent = 'hal' AND key = $1 LIMIT 1`,
      [`hal:onboarding_state:${adminId}`]
    );
    if (result.rows[0]?.value) {
      return JSON.parse(result.rows[0].value);
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Load historical analytics keys for AltWire sessions.
 * Returns null if no analytics data has been seeded yet.
 * @returns {Promise<object|null>}
 */
async function loadHistoricalAnalytics() {
  try {
    const result = await pool.query(
      `SELECT key, value FROM agent_memory
       WHERE agent = 'hal' AND key LIKE 'hal:altwire:analytics:%' AND deleted_at IS NULL`
    );
    if (result.rows.length === 0) return null;
    const parsed = {};
    for (const row of result.rows) {
      try {
        parsed[row.key] = JSON.parse(row.value);
      } catch {
        parsed[row.key] = row.value;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build Slack system context block for altwire channel.
 * @returns {string}
 */
function buildAltwireSlackContext() {
  return `## Slack Channel Context

You are active in the following Slack channel:

- *#altwire* — AltWire music publication. Derek's primary channel. This is an editorial context — music journalism, not e-commerce ops. Apply AltWire soul and editorial context in all responses here.`;

}

/**
 * Assemble the system prompt for an AltWire session.
 *
 * @param {'interactive'|'task'|'autonomous'} sessionType
 * @param {{ name: string, interface: string }} caller
 * @param {{ agentContext?: string, slackContext?: object }} context
 *   - agentContext: 'altwire' | null
 *   - slackContext: { channelId, threadContext } | null
 * @param {string} [taskGoal]
 * @returns {Promise<string>}
 */
export async function assembleSystemPrompt(sessionType, caller, context, taskGoal = null) {
  const parts = [];
  const agentContext = context?.agentContext ?? null;
  const isAltwire = agentContext === 'altwire';

  // Identity block — switch by context
  const soul = await loadSoul(agentContext);
  if (soul) {
    parts.push(`## Identity\n${soul}`);
  } else if (isAltwire) {
    parts.push(`## Identity\nYou are Hal, working with Derek at AltWire, a music and lifestyle publication. You are an editorial AI assistant — not e-commerce ops.`);
  } else {
    parts.push(`## Identity\nYou are Hal, the admin AI agent for AltWire Altus.`);
  }

  // Session type instruction
  if (sessionType === 'task') {
    parts.push(`## Session Mode\nThis is a task-mode session. Complete the assigned goal efficiently. Do not ask unnecessary follow-up questions unless critical to the task.`);
  } else if (sessionType === 'autonomous') {
    parts.push(`## Session Mode\nThis is an autonomous session. Execute proactively. Surface relevant insights without being asked.`);
  }

  // AltWire editorial context injection
  if (isAltwire) {
    const editorial = await loadEditorialContext();
    if (editorial) {
      const toneStr = editorial.tone
        ? `Tone: ${editorial.tone.overall || 'editorial'}. Formality: ${editorial.tone.formality || 'conversational'}.`
        : '';
      const articleTypes = editorial.article_types
        ? `Article mix: ${Object.entries(editorial.article_types).map(([k, v]) => `${k} ${v}`).join(', ')}.`
        : '';
      const voiceMarkers = editorial.voice_markers?.length
        ? `Voice markers: ${editorial.voice_markers.slice(0, 5).join(', ')}.`
        : '';
      const goodArticle = editorial.what_makes_good_altwire_article
        ? `What makes a good AltWire article: ${editorial.what_makes_good_altwire_article}`
        : '';

      parts.push(`## AltWire Editorial Context\n${[toneStr, articleTypes, voiceMarkers, goodArticle].filter(Boolean).join('\n')}`);
    }

    // Derek author profile if available
    const authorProfile = await loadDerekAuthorProfile();
    if (authorProfile?.what_to_preserve_in_ai_drafts) {
      parts.push(`## Derek's Voice\n${authorProfile.what_to_preserve_in_ai_drafts}`);
    }

    // Historical analytics context
    const analytics = await loadHistoricalAnalytics();
    if (analytics) {
      const ts = analytics[ANALYTICS_KEYS.traffic_summary];
      const ta = analytics[ANALYTICS_KEYS.top_articles_18m];
      const tt = analytics[ANALYTICS_KEYS.topic_trends];
      const ss = analytics[ANALYTICS_KEYS.seasonality];

      const trafficLines = [];
      if (ts) {
        trafficLines.push(`18-month total: ${ts.total_pageviews?.toLocaleString() ?? 'N/A'} pageviews`);
        if (ts.peak_month) trafficLines.push(`Peak month: ${ts.peak_month} (${ts.peak_month_pageviews?.toLocaleString() ?? 'N/A'} pageviews)`);
        if (ts.trend_direction) trafficLines.push(`Traffic trend: ${ts.trend_direction}`);
      }
      if (ta?.all_time_top_10?.length) {
        const top5 = ta.all_time_top_10.slice(0, 5);
        const topList = top5.map((a, i) => `${i + 1}. ${a.title} (${a.total_pageviews?.toLocaleString() ?? 'N/A'} pv)`).join('\n');
        trafficLines.push(`All-time top 5 articles:\n${topList}`);
      }
      if (tt?.rising_topics?.length) {
        const rising = tt.rising_topics.slice(0, 3).map((t) => t.topic).join(', ');
        trafficLines.push(`Rising topics: ${rising}`);
      }
      if (ss?.peak_season) {
        trafficLines.push(`Peak season: ${ss.peak_season}`);
      }
      if (trafficLines.length > 0) {
        parts.push(`## AltWire Historical Analytics\n${trafficLines.join('\n')}`);
      }
    }
  }

  // Slack context
  if (context?.slackContext?.channelId && isAltwire) {
    parts.push(buildAltwireSlackContext());
  }

  // Task goal
  if (taskGoal) {
    parts.push(`## Current Task\n${taskGoal}`);
  }

  // Onboarding note for new admins
  if (caller?.name) {
    const onboarding = await loadOnboardingState(caller.name);
    if (onboarding && onboarding.status !== 'complete') {
      parts.push(`## Onboarding Required\n${caller.name} has not completed onboarding. Recommend they run through it for a personalized experience.`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Get the Derek author profile for injection into generateDraft().
 * Exported separately so altus-writer.js can call it without importing assembleSystemPrompt.
 * @returns {Promise<object|null>}
 */
export async function getDerekAuthorProfile() {
  return loadDerekAuthorProfile();
}