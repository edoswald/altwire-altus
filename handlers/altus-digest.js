/**
 * Morning digest handler.
 * Aggregates AltWire analytics into a single daily briefing:
 *   week-over-week traffic and search deltas, risers/fallers, new
 *   opportunity-zone queries, Google News pickup, recent-article performance
 *   (see altus-digest-analytics.js), plus news alerts, story opportunities,
 *   yesterday's traffic, and the nightly editorial synthesis.
 *
 * Uses Promise.allSettled so individual source failures never block the digest.
 *
 * Historical analytics context (18-month memory keys) is loaded to surface
 * traffic comparisons and top-performing articles alongside fresh data.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { getSiteSearchKeywords, getTrafficSummary } from './altwire-matomo-client.js';
import { listStoryOpportunityQueue } from './altus-opportunity-queue.js';
import { buildAnalyticsSnapshot } from './altus-digest-analytics.js';
import { isCoreProfile } from '../lib/altus-profile.js';
import { listStoryQueue } from './altus-story-scan.js';
import { getAnalyticsHistory, summarizeHistory } from './altus-history.js';
import { isoDateOffset } from '../lib/gsc-date-window.js';

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

/** Digest sections specific to the core profile. Failures become warnings. */
async function buildCoreSections(warnings) {
  const start = isoDateOffset(7);
  const end = isoDateOffset(1);
  const [queue, search, monthly] = await Promise.allSettled([
    listStoryQueue({ status: 'open', limit: 5 }),
    getSiteSearchKeywords('range', `${start},${end}`),
    getAnalyticsHistory(),
  ]);

  let story_opportunities = null;
  if (queue.status === 'fulfilled') {
    story_opportunities = {
      open_count: queue.value.open_count,
      last_scan_at: queue.value.last_scan_at,
      top: queue.value.opportunities,
    };
  } else {
    warnings.push({ section: 'story_opportunities', message: `Story queue read failed: ${queue.reason?.message ?? queue.reason}` });
  }

  let site_search_keywords = null;
  const result = search.status === 'fulfilled' ? search.value : { error: search.reason?.message };
  if (Array.isArray(result)) {
    site_search_keywords = {
      source: 'Matomo',
      window: { start, end },
      keywords: result.slice(0, 15).map((r) => ({ keyword: r.label, searches: r.nb_visits ?? r.nb_hits ?? null })),
    };
  } else if (result?.error) {
    warnings.push({ section: 'site_search_keywords', message: `Matomo site search failed: ${result.message ?? result.error}` });
  }
  let history = null;
  const built = monthly.status === 'fulfilled' ? monthly.value : { error: monthly.reason?.message };
  if (built?.error) {
    warnings.push({ section: 'history', message: `Monthly history unavailable: ${built.error}` });
  } else {
    history = summarizeHistory(built);
  }
  return { story_opportunities, site_search_keywords, history };
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
      analytics: null,
      news_alerts: null,
      story_opportunities: null,
      traffic: null,
    };
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Fire all fetches in parallel — failures are isolated per section
  const [
    analyticsResult,
    newsAlertsResult,
    storyOppsResult,
    trafficResult,
    freshTrafficResult,
    freshTopArticlesResult,
    freshGscOppsResult,
    editorialSynthesisResult,
    siteSearchKeywordsResult,
  ] = await Promise.allSettled([
    buildAnalyticsSnapshot({ days: 7 }),
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
    getTrafficSummary('day', 'yesterday'),
    pool.query('SELECT value FROM agent_memory WHERE agent = $1 AND key = $2 LIMIT 1', ['hal', 'hal:altwire:traffic_summary']),
    pool.query('SELECT value FROM agent_memory WHERE agent = $1 AND key = $2 LIMIT 1', ['hal', 'hal:altwire:top_articles']),
    pool.query('SELECT value FROM agent_memory WHERE agent = $1 AND key = $2 LIMIT 1', ['hal', 'hal:altwire:gsc:fresh_opportunities']),
    pool.query('SELECT value FROM agent_memory WHERE agent = $1 AND key = $2 LIMIT 1', ['hal', 'hal:altwire:combined_synthesis']),
    pool.query('SELECT value FROM agent_memory WHERE agent = $1 AND key = $2 LIMIT 1', ['hal', 'hal:altwire:site_search_keywords']),
  ]);

  // Load historical analytics context alongside fresh fetches
  const analyticsCtx = await loadAnalyticsContext();

  const warnings = [];

  // --- Analytics snapshot (7d vs prior 7d) ---
  let analytics = null;
  if (analyticsResult.status === 'fulfilled') {
    analytics = analyticsResult.value;
    for (const w of analytics.warnings ?? []) {
      warnings.push({ section: `analytics_${w.section}`, message: w.message });
    }
  } else {
    warnings.push({ section: 'analytics', message: `Analytics snapshot failed: ${analyticsResult.reason?.message || analyticsResult.reason}` });
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
          top: opportunities.slice(0, 5),
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
    gsc: isCoreProfile()
      ? { configured: gscEnvPresent, reachable: !!analytics?.search }
      : {
        configured: gscEnvPresent,
        reachable: !!historical?.gsc_summary_16m,
        last_refreshed: historical?.gsc_summary_16m?.last_refreshed ?? null,
      },
  };

  // --- Build response ---
  // In the core profile (read by the Managed Agent), leave out the Hal-era
  // snapshots the legacy reflection cron stores. Each covers a different
  // window and time than `analytics`, so they contradicted it (a "7-day"
  // traffic figure that didn't match the live one), and they stop updating
  // once the legacy service is retired. `analytics` already has the live
  // equivalents; site search terms and long-run history stay.
  const core = isCoreProfile();
  const legacyBlocks = core
    ? {}
    : { fresh_traffic, fresh_top_articles, fresh_gsc_opps, editorial_synthesis };

  // Core (the Managed Agent): story opportunities from the story-scan queue,
  // site search computed live for the last 7 days, the rebuilt monthly
  // history (altus-history.js) in place of the Hal-era 18-month summaries,
  // which were built from inflated weekly data, and no watch-list alerts.
  const coreBlocks = core ? await buildCoreSections(warnings) : null;

  const digest = {
    date: today,
    generated_at: new Date().toISOString(),
    analytics,
    ...(core ? {} : { news_alerts }),
    story_opportunities: core ? coreBlocks.story_opportunities : story_opportunities,
    traffic,
    ...(core ? { history: coreBlocks.history } : { historical }),
    providers,
    ...legacyBlocks,
    site_search_keywords: core ? coreBlocks.site_search_keywords : site_search_keywords,
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
    has_analytics: !!analytics,
  });

  return digest;
}
