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
const DEREK_AUTHOR_KEY = 'hal:altwire:derek_author_profile';

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
      [DEREK_AUTHOR_KEY]
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