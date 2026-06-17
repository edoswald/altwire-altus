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

/**
 * Build a ## Current Time block in a given timezone.
 * Injected into every session prompt so Altus never loses track of date/time.
 *
 * @param {string} timezone — IANA timezone string, e.g. 'America/New_York'
 * @returns {string}
 */
function buildCurrentTimeBlock(timezone = 'America/New_York') {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => parts.find(p => p.type === type)?.value ?? '';
  return [
    `## Current Time`,
    `Day: ${get('weekday')}, ${get('month')} ${get('day')}, ${get('year')}`,
    `Time: ${get('hour')}:${get('minute')} ${get('dayPeriod')} (${timezone} / ${get('timeZoneName')})`,
    `Relative: today, ${get('weekday')}`,
  ].join('\n');
}

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

const FRESH_REFLECTION_KEYS = [
  'hal:altwire:combined_synthesis',
  'hal:altwire:traffic_summary',
  'hal:altwire:top_articles',
  'hal:altwire:site_search_keywords',
  'hal:altwire:gsc:fresh_opportunities',
];

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
 * Load fresh nightly reflection data for AltWire sessions.
 * Reads the keys written by altus-reflection.js (combined_synthesis, traffic, articles, etc.)
 * and today's news monitor alert. Returns null if reflection hasn't run yet.
 * @returns {Promise<object|null>}
 */
async function loadFreshReflectionData() {
  try {
    const [halResult, newsResult] = await Promise.all([
      pool.query(
        `SELECT key, value FROM agent_memory
         WHERE agent = 'hal' AND key = ANY($1) AND deleted_at IS NULL`,
        [FRESH_REFLECTION_KEYS],
      ),
      pool.query(
        `SELECT value FROM agent_memory
         WHERE agent = 'altus' AND key = $1 AND deleted_at IS NULL LIMIT 1`,
        [`altus:news_alert:${new Date().toISOString().slice(0, 10)}`],
      ),
    ]);

    if (halResult.rows.length === 0) return null;

    const parsed = {};
    for (const row of halResult.rows) {
      try { parsed[row.key] = JSON.parse(row.value); }
      catch { parsed[row.key] = row.value; }
    }

    const out = {
      combined_synthesis: parsed['hal:altwire:combined_synthesis'] ?? null,
      traffic_summary:    parsed['hal:altwire:traffic_summary'] ?? null,
      top_articles:       parsed['hal:altwire:top_articles'] ?? null,
      site_search_keywords: parsed['hal:altwire:site_search_keywords'] ?? null,
      gsc_opportunities:  parsed['hal:altwire:gsc:fresh_opportunities'] ?? null,
      news_monitor:       null,
    };

    if (newsResult.rows[0]?.value) {
      try { out.news_monitor = JSON.parse(newsResult.rows[0].value); }
      catch { /* ignore */ }
    }

    return out;
  } catch {
    return null;
  }
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
 * @param {{ name: string, interface: string, scope?: string }} caller
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
  const isGuest = caller?.scope === 'guest';

  // Identity block — switch by context
  const soul = await loadSoul(agentContext);
  if (soul) {
    parts.push(`## Identity\n${soul}`);
  } else if (isAltwire) {
    parts.push(`## Identity\nYou are Hal, working with Derek at AltWire, a music and lifestyle publication. You are an editorial AI assistant — not e-commerce ops.`);
  } else {
    parts.push(`## Identity\nYou are Hal, the admin AI agent for AltWire Altus.`);
  }

  // Current Time — always present, every session type
  parts.push(buildCurrentTimeBlock('America/New_York'));

  // Session type instruction
  if (sessionType === 'task') {
    parts.push(`## Session Mode\nThis is a task-mode session. Complete the assigned goal efficiently. Do not ask unnecessary follow-up questions unless critical to the task.`);
  } else if (sessionType === 'autonomous') {
    parts.push(
      `## Session Mode\n` +
      `This is an autonomous session. Execute proactively. Surface relevant insights without being asked.\n\n` +
      `**Run order:**\n` +
      `1. Review Altus action items with \`altus_list_action_items\`; accept or complete actionable editorial/SEO follow-through with \`altus_manage_action_item\` when the required data is available.\n` +
      `2. Use AltWire SEO and analytics tools — \`get_altwire_search_opportunities\`, \`get_altwire_search_performance\`, \`get_altwire_sitemap_health\`, \`get_altwire_seo_state\`, and \`update_altwire_seo_fields\` — only for clear editorial/search improvements. Do not change WordPress publishing status autonomously.\n` +
      `3. Use \`altus_web_research\` and \`altus_topic_synthesis\` when an action item or scheduled task needs current external information.\n` +
      `4. Use \`altus_send_admin_email\` only for configured admin recipients when a completed-work update, small blocking question, or urgent admin alert would prevent harmless work from stalling.\n` +
      `5. When a thread includes both Cirrusly and AltWire admins and teaches durable Hal-level context, write a concise \`hal:portable_context:*\` memory in Altus or preserve a note to mirror it into Nimbus when available.\n\n` +
      `**Forbidden autonomous actions:** Do not post to WordPress, publish drafts, notify subscribers, send non-admin email, or make irreversible editorial/business decisions without explicit admin direction.`
    );
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

    // Fresh nightly reflection data (written by 4 AM reflection cron)
    const fresh = await loadFreshReflectionData();
    if (fresh) {
      const freshLines = [];

      // Synthesis headline + editorial recommendation
      const synth = fresh.combined_synthesis?.synthesis;
      if (synth?.headline) {
        freshLines.push(`Summary: ${synth.headline}`);
      }

      // 7-day traffic
      const t7 = fresh.traffic_summary?.period_7d;
      if (t7?.nb_pageviews != null) {
        freshLines.push(`7-day traffic: ${t7.nb_pageviews.toLocaleString()} pageviews, ${(t7.nb_visits ?? 0).toLocaleString()} visits`);
      }

      // Top articles (7d)
      const articles = fresh.top_articles?.articles;
      if (Array.isArray(articles) && articles.length > 0) {
        const top3 = articles.slice(0, 3)
          .map((a, i) => `  ${i + 1}. ${a.title ?? a.label ?? a.url} (${(a.pageviews ?? a.nb_hits ?? 0).toLocaleString()} pv)`)
          .join('\n');
        freshLines.push(`Top articles (7d):\n${top3}`);
      }

      // Site search keywords (7d)
      const kwRaw = fresh.site_search_keywords?.keywords;
      if (Array.isArray(kwRaw) && kwRaw.length > 0) {
        const kws = kwRaw.slice(0, 5).map(k => k.label ?? k.keyword ?? String(k)).join(', ');
        freshLines.push(`Reader site searches (7d): ${kws}`);
      }

      // GSC content gaps + opportunities
      if (synth?.content_gaps?.length > 0) {
        const gaps = synth.content_gaps.slice(0, 3).map(g => g.query).join('; ');
        freshLines.push(`Content gaps: ${gaps}`);
      }
      if (synth?.opportunity_alignments?.length > 0) {
        const opps = synth.opportunity_alignments.slice(0, 3).map(o => o.query).join('; ');
        freshLines.push(`SEO opportunities: ${opps}`);
      }

      // Editorial recommendation
      if (synth?.editorial_recommendation) {
        freshLines.push(`Editorial recommendation: ${synth.editorial_recommendation}`);
      }

      // Watch list news matches
      const newsMatches = fresh.news_monitor?.watch_list_matches;
      if (Array.isArray(newsMatches) && newsMatches.length > 0) {
        const matchStr = newsMatches.slice(0, 3)
          .map(m => `${m.matched_items?.join(', ')} — "${m.query}"`)
          .join('; ');
        freshLines.push(`Watch list news matches today: ${matchStr}`);
      }

      // Age stamp
      const generatedAt = fresh.combined_synthesis?.generated_at ?? fresh.traffic_summary?.generated_at;
      if (generatedAt) {
        const ageH = Math.round((Date.now() - new Date(generatedAt).getTime()) / 3_600_000);
        if (ageH < 48) freshLines.push(`(Data from ${ageH}h ago)`);
      }

      if (freshLines.length > 0) {
        parts.push(`## AltWire Fresh Analytics\n${freshLines.join('\n')}`);
      }
    }

    parts.push(`## AltWire Tool Freshness and Routing
Fresh analytics and reflection memory can orient you, but it is not a substitute for live verification when Derek asks for current AltWire analytics, SEO, archive, or editorial intelligence. Do not answer these from memory alone; call the most specific tool first, then synthesize from the tool result.

Use these routes for common smoke-test and production prompts:
- "Where are our biggest coverage gaps right now?" -> get_story_opportunities first; use refresh=true for smoke tests or "right now" checks. Use analyze_coverage_gaps only when the user names a specific artist/topic to assess.
- "Any breaking news opportunities from the monitor?" -> get_news_opportunities. Do not replace this with general Google News performance unless the tool result explicitly has no monitor/watch-list matches.
- "Which past articles performed best, and what's the pattern?" -> get_article_performance first, then get_news_performance_patterns when the user asks for a pattern or News pickup.
- "What are our top pages this week?" -> get_altwire_top_pages.
- "Where is our traffic coming from?" -> get_altwire_traffic_sources.
- "What are people searching for on the site?" -> get_altwire_site_search.
- "How are we doing in Google Search -- show search performance for the last 28 days, by query and page." -> get_altwire_search_performance with dimensions ["query","page"].
- "What SEO opportunities should we chase?" -> get_altwire_search_opportunities or get_altwire_opportunity_zone_queries.
- "Is our sitemap healthy?" -> get_altwire_sitemap_health. Always call the live sitemap tool for this prompt; do not answer from memory or prior context.
- "Is there anything in Postgres?", "Are the backing tables populated?", or "Why are there no opportunities?" -> altus_get_data_health.

When a specific tool returns no rows, say that plainly and keep the answer anchored to that result instead of filling the gap with adjacent cached analytics.`);
  }

  // Guest / test-account notice — keep beta testing data isolated
  if (isGuest) {
    parts.push(`## Test Account Notice
You are operating under a guest test account (${caller.name}). This is a testing session, not Derek's primary account. Treat all writes as potentially disruptive to Derek's live environment.
- **Do not write to shared tables** — no watch list entries, review tracker items, loaners, action items, article assignments, or WordPress posts — unless the user explicitly says this is an intentional test and confirms.
- **Watch list is live** — entries you add go directly into Derek's news monitoring. Do not add test subjects.
- **Memory writes must be namespaced** — prefix any memory key you write with "private:${caller.name.toLowerCase()}:" (e.g. "private:ed:..."). Never write to top-level hal:altwire:* or altus:* keys during a guest session.
- You may read all shared editorial context, analytics, action items, reviews, and memory freely — reads are safe.
- If unsure whether an action writes shared state, ask before proceeding.`);
  }

  parts.push(
    `## Portable Memory Guidance\n\n` +
    `Hal can operate through both Nimbus for Cirrusly and Altus for AltWire. ` +
    `Use \`hal:portable_context:*\` keys for reusable Hal-level knowledge that should follow him across MCP backends: cross-company admin preferences, collaboration norms, durable task context, and facts Ed or Derek will expect Hal to know in either environment.\n\n` +
    `Keep business-specific facts in business-specific memory. AltWire editorial context belongs in \`hal:altwire:*\` or Altus memory; Cirrusly operational data belongs in Nimbus/Cirrusly memory. ` +
    `Portable memory should be narrow, evidence-based, and explicit about source, scope, and whether it should be mirrored to Nimbus. Never store secrets, customer data, supplier details, or one-business-only operational state as portable context.`
  );

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
