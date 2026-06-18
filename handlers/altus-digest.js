/**
 * Morning digest handler.
 * Aggregates 7 data sources into a single daily briefing:
 *   uptime, incidents, news alerts, story opportunities,
 *   review deadlines, overdue loaners, and yesterday's traffic.
 *
 * Uses Promise.allSettled so individual source failures never block the digest.
 *
 * Historical analytics context (18-month memory keys) is loaded to surface
 * traffic comparisons and top-performing articles alongside fresh data.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { getAltwireUptime, getAltwireIncidents } from './altus-monitoring.js';
import { getTrafficSummary } from './altwire-matomo-client.js';
import { getAiCostSummary } from '../lib/ai-cost-tracker.js';
import { listStoryOpportunityQueue } from './altus-opportunity-queue.js';

const ANALYTICS_KEYS = {
  traffic_summary:    'hal:altwire:analytics:traffic_summary',
  top_articles_18m:  'hal:altwire:analytics:top_articles_18m',
  seasonality:       'hal:altwire:analytics:seasonality',
  topic_trends:      'hal:altwire:analytics:topic_trends',
  gsc_summary_16m:   'hal:altwire:gsc:summary_16m',
  gsc_last_refreshed: 'hal:altwire:gsc:last_refreshed',
  combined_synthesis: 'hal:altwire:combined_synthesis',
};

async function loadAnalyticsContext() {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM agent_memory
       WHERE agent = 'hal' AND (key LIKE 'hal:altwire:analytics:%' OR key LIKE 'hal:altwire:gsc:%' OR key = 'hal:altwire:combined_synthesis') AND deleted_at IS NULL`
    );
    if (!rows.length) return null;
    const ctx = {};
    for (const row of rows) {
      try { ctx[row.key] = JSON.parse(row.value); } catch { ctx[row.key] = row.value; }
    }
    return ctx;
  } catch { return null; }
}

function normalizeWatchListMatches(matches) {
  if (!Array.isArray(matches)) return [];

  return matches.flatMap((match) => {
    if (Array.isArray(match.matched_items)) {
      return match.matched_items.map((name) => ({
        name,
        query: match.query,
        source: 'google_news',
      }));
    }

    if (match.name && match.query) {
      return [{
        name: match.name,
        query: match.query,
        source: match.source ?? 'google_news',
      }];
    }

    return [];
  });
}

// Short-lived cache for the assembled digest. Each build fans out to ~14
// upstream calls (GSC, Matomo, Postgres), and the dashboard can request the
// digest several times in quick succession (mount + Sync + post-deploy
// reconnects). Collapse those into one build per TTL window, and dedupe
// concurrent in-flight builds so a burst of requests triggers a single build.
const DIGEST_CACHE_TTL_MS = 60_000;
let _digestCache = { at: 0, value: null };
let _digestInFlight = null;

/**
 * Cached entry point for the morning digest. Returns a recent build when one is
 * available, otherwise builds once and shares that build with any concurrent
 * callers. TEST_MODE always builds fresh (the canned response is cheap).
 * @returns {Promise<object>}
 */
export async function getAltwireMorningDigest() {
  if (process.env.TEST_MODE === 'true') return buildMorningDigest();

  const now = Date.now();
  if (_digestCache.value && now - _digestCache.at < DIGEST_CACHE_TTL_MS) {
    return _digestCache.value;
  }
  if (_digestInFlight) return _digestInFlight;

  _digestInFlight = (async () => {
    try {
      const digest = await buildMorningDigest();
      _digestCache = { at: Date.now(), value: digest };
      return digest;
    } finally {
      _digestInFlight = null;
    }
  })();
  return _digestInFlight;
}

/**
 * Build the daily morning digest from all available data sources.
 * @returns {Promise<object>} Aggregate digest with date, generated_at, and 7 sections.
 */
async function buildMorningDigest() {
  // TEST_MODE guard — return canned response, skip all live calls
  if (process.env.TEST_MODE === 'true') {
    return {
      test_mode: true,
      date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
      generated_at: new Date().toISOString(),
      uptime: { site: { status: 'up' }, wp_cron: { status: 'up' } },
      incidents: { site: [], wp_cron: [] },
      news_alerts: null,
      story_opportunities: null,
      review_deadlines: { reviews: [], count: 0 },
      overdue_loaners: { loaners: [], count: 0 },
      traffic: null,
      ai_costs: null,
    };
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Fire all 14 fetches in parallel — failures are isolated per section
  const [
    uptimeResult,
    incidentsResult,
    newsAlertsResult,
    storyOppsResult,
    reviewsResult,
    loanersResult,
    trafficResult,
    aiCostResult,
    freshTrafficResult,
    freshTopArticlesResult,
    freshGscOppsResult,
    editorialSynthesisResult,
    siteSearchKeywordsResult,
    actionItemsResult,
  ] = await Promise.allSettled([
    getAltwireUptime(),
    getAltwireIncidents(),
    // Most recent available news-alert snapshot. Prefer today's, but fall back to
    // the latest prior day so the count never collapses to 0 just because the
    // 4:30 AM ET news_monitor cron hasn't run yet for the current date.
    // Keys are `altus:news_alert:YYYY-MM-DD`, so DESC ordering returns the newest.
    pool.query(
      `SELECT key, value FROM agent_memory
       WHERE agent = 'altus' AND key LIKE 'altus:news_alert:%' AND deleted_at IS NULL
       ORDER BY key DESC LIMIT 1`,
    ),
    listStoryOpportunityQueue({ status: 'active', limit: 50 }),
    pool.query(
      `SELECT id, title, reviewer, due_date, status FROM altus_reviews
       WHERE due_date IS NOT NULL
         AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
         AND status NOT IN ('published', 'cancelled')
       ORDER BY due_date ASC`,
    ),
    pool.query(
      `SELECT id, item_name, brand, borrower, expected_return_date, status FROM altus_loaners
       WHERE expected_return_date < CURRENT_DATE
         AND actual_return_date IS NULL
         AND status NOT IN ('returned', 'kept', 'lost')
       ORDER BY expected_return_date ASC`,
    ),
    getTrafficSummary('day', 'yesterday'),
    getAiCostSummary(),
    pool.query('SELECT value FROM agent_memory WHERE agent = $1 AND key = $2 LIMIT 1', ['hal', 'hal:altwire:traffic_summary']),
    pool.query('SELECT value FROM agent_memory WHERE agent = $1 AND key = $2 LIMIT 1', ['hal', 'hal:altwire:top_articles']),
    pool.query('SELECT value FROM agent_memory WHERE agent = $1 AND key = $2 LIMIT 1', ['hal', 'hal:altwire:gsc:fresh_opportunities']),
    pool.query('SELECT value FROM agent_memory WHERE agent = $1 AND key = $2 LIMIT 1', ['hal', 'hal:altwire:combined_synthesis']),
    pool.query('SELECT value FROM agent_memory WHERE agent = $1 AND key = $2 LIMIT 1', ['hal', 'hal:altwire:site_search_keywords']),
    pool.query(
      `SELECT id, title, category, signal_source, proposed_at FROM altus_action_items
       WHERE status = 'proposed'
       ORDER BY proposed_at DESC LIMIT 5`,
    ),
  ]);

  // Load historical analytics context alongside fresh fetches
  const analyticsCtx = await loadAnalyticsContext();

  const warnings = [];

  // --- Uptime ---
  let uptime = null;
  if (uptimeResult.status === 'fulfilled') {
    uptime = uptimeResult.value;
  } else {
    uptime = null;
    warnings.push({ section: 'uptime', message: `Uptime fetch failed: ${uptimeResult.reason?.message || uptimeResult.reason}` });
  }

  // --- Incidents ---
  let incidents = null;
  if (incidentsResult.status === 'fulfilled') {
    incidents = incidentsResult.value;
  } else {
    incidents = null;
    warnings.push({ section: 'incidents', message: `Incidents fetch failed: ${incidentsResult.reason?.message || incidentsResult.reason}` });
  }

  // --- News Alerts (agent memory) ---
  let news_alerts = null;
  if (newsAlertsResult.status === 'fulfilled') {
    const rows = newsAlertsResult.value.rows;
    if (rows && rows.length > 0) {
      try {
        const parsed = JSON.parse(rows[0].value);
        // Snapshot date is encoded in the key (altus:news_alert:YYYY-MM-DD).
        const asOf = (rows[0].key || '').split(':').pop() || null;
        news_alerts = {
          ...parsed,
          watch_list_matches: normalizeWatchListMatches(parsed.watch_list_matches),
          as_of: asOf,
          stale: asOf ? asOf !== today : false,
        };
      } catch (e) {
        warnings.push({ section: 'news_alerts', message: `Failed to parse news alerts JSON: ${e.message}` });
      }
    }
    // Empty rows = no news snapshot has ever been stored — not an error, render gracefully in email
  } else {
    warnings.push({ section: 'news_alerts', message: `News alerts fetch failed: ${newsAlertsResult.reason?.message || newsAlertsResult.reason}` });
  }

  // --- Story Opportunities (queue table, populated by the 5 AM weekday cron) ---
  let story_opportunities = null;
  if (storyOppsResult.status === 'fulfilled') {
    const queue = storyOppsResult.value;
    if (queue?.success) {
      const opportunities = queue.opportunities ?? [];
      if (opportunities.length > 0) {
        story_opportunities = {
          count: opportunities.length,
          top: opportunities.slice(0, 3),
          pitches: null,
        };
      }
      // Empty queue = nothing pending — render gracefully in email
    } else if (queue?.error) {
      warnings.push({ section: 'story_opportunities', message: `Story opportunities query failed: ${queue.error}` });
    }
  } else {
    warnings.push({ section: 'story_opportunities', message: `Story opportunities fetch failed: ${storyOppsResult.reason?.message || storyOppsResult.reason}` });
  }

  // --- Review Deadlines ---
  let review_deadlines = null;
  let review_deadlines_warning = null;
  if (reviewsResult.status === 'fulfilled') {
    const rows = reviewsResult.value.rows;
    review_deadlines = { reviews: rows, count: rows.length };
  } else {
    review_deadlines = null;
    review_deadlines_warning = `Review deadlines fetch failed: ${reviewsResult.reason?.message || reviewsResult.reason}`;
  }
  if (review_deadlines_warning) {
    warnings.push({ section: 'review_deadlines', message: review_deadlines_warning });
  }

  // --- Overdue Loaners ---
  let overdue_loaners = null;
  let overdue_loaners_warning = null;
  if (loanersResult.status === 'fulfilled') {
    const rows = loanersResult.value.rows;
    overdue_loaners = { loaners: rows, count: rows.length };
  } else {
    overdue_loaners = null;
    overdue_loaners_warning = `Overdue loaners fetch failed: ${loanersResult.reason?.message || loanersResult.reason}`;
  }
  if (overdue_loaners_warning) {
    warnings.push({ section: 'overdue_loaners', message: overdue_loaners_warning });
  }

  // --- Traffic (Matomo) ---
  let traffic = null;
  let traffic_warning = null;
  if (trafficResult.status === 'fulfilled') {
    const result = trafficResult.value;
    if (result && result.error) {
      traffic = null;
      traffic_warning = `Matomo error: ${result.error}${result.message ? ' — ' + result.message : ''}`;
    } else {
      traffic = result;
    }
  } else {
    traffic = null;
    traffic_warning = `Traffic fetch failed: ${trafficResult.reason?.message || trafficResult.reason}`;
  }
  if (traffic_warning) {
    warnings.push({ section: 'traffic', message: traffic_warning });
  }

  // --- AI Costs ---
  let ai_costs = null;
  let ai_costs_warning = null;
  if (aiCostResult.status === 'fulfilled') {
    ai_costs = aiCostResult.value;
  } else {
    ai_costs = null;
    ai_costs_warning = `AI cost summary failed: ${aiCostResult.reason?.message || aiCostResult.reason}`;
  }
  if (ai_costs_warning) {
    warnings.push({ section: 'ai_costs', message: ai_costs_warning });
  }

  // --- Fresh reflection data (written by 4 AM cron) ---
  const parseMemoryRow = (result) => {
    if (result.status !== 'fulfilled') return null;
    const row = result.value?.rows?.[0];
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  };

  const fresh_traffic        = parseMemoryRow(freshTrafficResult);
  const fresh_top_articles   = parseMemoryRow(freshTopArticlesResult);
  const fresh_gsc_opps       = parseMemoryRow(freshGscOppsResult);
  const editorial_synthesis  = parseMemoryRow(editorialSynthesisResult);
  const site_search_keywords = parseMemoryRow(siteSearchKeywordsResult);

  // --- Open action items (proposed, most recent first) ---
  let open_action_items = null;
  if (actionItemsResult.status === 'fulfilled') {
    open_action_items = { items: actionItemsResult.value.rows, count: actionItemsResult.value.rows.length };
  }

  // --- Build historical analytics context ---
  let historical = null;
  if (analyticsCtx) {
    const ts = analyticsCtx[ANALYTICS_KEYS.traffic_summary];
    const ta = analyticsCtx[ANALYTICS_KEYS.top_articles_18m];
    const ss = analyticsCtx[ANALYTICS_KEYS.seasonality];
    const tt = analyticsCtx[ANALYTICS_KEYS.topic_trends];

    historical = {};
    if (ts) {
      const avgMonthly = ts.avg_monthly_pageviews ?? 0;
      const yesterdayPv = traffic?.nb_pageviews ?? 0;
      const vsAvg = avgMonthly > 0 ? Math.round(((yesterdayPv * 30) - avgMonthly) / avgMonthly * 100) : 0;
      historical.traffic_summary = {
        total_pageviews_18m: ts.total_pageviews ?? 0,
        avg_monthly_pageviews: avgMonthly,
        peak_month: ts.peak_month ?? null,
        peak_month_pageviews: ts.peak_month_pageviews ?? 0,
        trend_direction: ts.trend_direction ?? null,
        yesterday_pageviews: yesterdayPv,
        vs_monthly_avg_pct: vsAvg,
      };
    }
    if (ta?.all_time_top_10?.length) {
      historical.top_articles_18m = ta.all_time_top_10.slice(0, 5).map((a, i) => ({
        rank: i + 1,
        title: a.title ?? 'Unknown',
        total_pageviews: a.total_pageviews ?? 0,
        first_month: a.first_month_seen ?? null,
      }));
    }
    if (ss) {
      historical.seasonality = {
        peak_season: ss.peak_season ?? null,
        low_season: ss.low_season ?? null,
      };
    }
    if (tt?.rising_topics?.length) {
      historical.rising_topics = tt.rising_topics.slice(0, 5).map((t) => t.topic);
    }

    const gsc = analyticsCtx[ANALYTICS_KEYS.gsc_summary_16m];
    const gscRefreshed = analyticsCtx[ANALYTICS_KEYS.gsc_last_refreshed];
    if (gsc) {
      historical.gsc_summary_16m = {
        total_clicks: gsc.total_clicks ?? null,
        total_impressions: gsc.total_impressions ?? null,
        avg_ctr: gsc.avg_ctr ?? null,
        avg_position: gsc.avg_position ?? null,
        peak_month: gsc.peak_month ?? null,
        trend_direction: gsc.trend_direction ?? null,
        last_refreshed: gscRefreshed?.timestamp ?? null,
      };
    }

    const synth = analyticsCtx[ANALYTICS_KEYS.combined_synthesis];
    if (synth?.synthesis) {
      historical.combined_synthesis = {
        headline: synth.synthesis.headline ?? null,
        search_traffic_share_pct: synth.synthesis.search_traffic_share_pct ?? null,
        editorial_recommendation: synth.synthesis.editorial_recommendation ?? null,
        generated_at: synth.generated_at ?? null,
      };
    }
  }

  // --- Provider configuration flags (env-based, not error-based) ---
  // Distinguish between "not configured" (env vars missing) and "transient failure"
  // (configured but call failed). Also surface "not_configured" when the underlying
  // call returned that specific error.
  const matomoEnvPresent =
    !!(process.env.ALTWIRE_MATOMO_URL && process.env.ALTWIRE_MATOMO_TOKEN_AUTH && process.env.ALTWIRE_MATOMO_SITE_ID);
  const gscEnvPresent =
    !!(process.env.ALTWIRE_GSC_SERVICE_ACCOUNT_JSON && process.env.ALTWIRE_GSC_SITE_URL);

  // If the matomo call returned a configuration error, mark it as not configured even
  // if env vars are present (e.g. JSON parse error on token).
  const matomoNotConfiguredError =
    trafficResult.status === 'fulfilled' &&
    trafficResult.value?.error === 'matomo_not_configured';

  const providers = {
    matomo: {
      configured: matomoEnvPresent && !matomoNotConfiguredError,
      reachable: trafficResult.status === 'fulfilled' && !trafficResult.value?.error,
      last_error: trafficResult.status === 'fulfilled' ? (trafficResult.value?.error ?? null) : (trafficResult.reason?.message ?? 'unknown'),
    },
    gsc: {
      configured: gscEnvPresent,
      reachable: !!historical?.gsc_summary_16m,
      last_refreshed: historical?.gsc_summary_16m?.last_refreshed ?? null,
    },
  };

  // --- Build response ---
  const digest = {
    date: today,
    generated_at: new Date().toISOString(),
    uptime,
    incidents,
    news_alerts,
    story_opportunities,
    review_deadlines,
    overdue_loaners,
    traffic,
    ai_costs,
    historical,
    providers,
    fresh_traffic,
    fresh_top_articles,
    fresh_gsc_opps,
    editorial_synthesis,
    site_search_keywords,
    open_action_items,
  };

  // Include per-section warning fields for failed sections
  for (const w of warnings) {
    digest[`${w.section}_warning`] = w.message;
  }

  // Include warnings array if any exist
  if (warnings.length > 0) {
    digest.warnings = warnings;
  }

  logger.info('Morning digest generated', {
    date: today,
    sections_warned: warnings.length,
    has_fresh_traffic: !!fresh_traffic,
    has_fresh_articles: !!fresh_top_articles,
    has_editorial_synthesis: !!editorial_synthesis,
    has_site_search: !!site_search_keywords,
    open_action_items: open_action_items?.count ?? 0,
  });

  return digest;
}
