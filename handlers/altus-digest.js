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

const ANALYTICS_KEYS = {
  traffic_summary:    'hal:altwire:analytics:traffic_summary',
  top_articles_18m:  'hal:altwire:analytics:top_articles_18m',
  seasonality:       'hal:altwire:analytics:seasonality',
  topic_trends:      'hal:altwire:analytics:topic_trends',
};

async function loadAnalyticsContext() {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM agent_memory
       WHERE agent = 'hal' AND key LIKE 'hal:altwire:analytics:%' AND deleted_at IS NULL`
    );
    if (!rows.length) return null;
    const ctx = {};
    for (const row of rows) {
      try { ctx[row.key] = JSON.parse(row.value); } catch { ctx[row.key] = row.value; }
    }
    return ctx;
  } catch { return null; }
}

/**
 * Build the daily morning digest from all available data sources.
 * @returns {Promise<object>} Aggregate digest with date, generated_at, and 7 sections.
 */
export async function getAltwireMorningDigest() {
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
    };
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Fire all 7 fetches in parallel — failures are isolated per section
  const [
    uptimeResult,
    incidentsResult,
    newsAlertsResult,
    storyOppsResult,
    reviewsResult,
    loanersResult,
    trafficResult,
  ] = await Promise.allSettled([
    getAltwireUptime(),
    getAltwireIncidents(),
    pool.query(
      'SELECT value FROM agent_memory WHERE key = $1 AND agent = $2 LIMIT 1',
      ['altus:news_alert:' + today, 'altus'],
    ),
    pool.query(
      'SELECT value FROM agent_memory WHERE key = $1 AND agent = $2 LIMIT 1',
      ['altus:story_opportunities:' + today, 'altus'],
    ),
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
  let news_alerts_warning = null;
  if (newsAlertsResult.status === 'fulfilled') {
    const rows = newsAlertsResult.value.rows;
    if (rows && rows.length > 0) {
      try {
        news_alerts = JSON.parse(rows[0].value);
      } catch (e) {
        news_alerts = null;
        news_alerts_warning = `Failed to parse news alerts JSON: ${e.message}`;
      }
    } else {
      news_alerts = null;
      news_alerts_warning = 'No data available for today';
    }
  } else {
    news_alerts = null;
    news_alerts_warning = `News alerts fetch failed: ${newsAlertsResult.reason?.message || newsAlertsResult.reason}`;
  }
  if (news_alerts_warning) {
    warnings.push({ section: 'news_alerts', message: news_alerts_warning });
  }

  // --- Story Opportunities (agent memory) ---
  let story_opportunities = null;
  let story_opportunities_warning = null;
  if (storyOppsResult.status === 'fulfilled') {
    const rows = storyOppsResult.value.rows;
    if (rows && rows.length > 0) {
      try {
        const parsed = JSON.parse(rows[0].value);
        const opportunities = parsed.opportunities || [];
        story_opportunities = {
          count: opportunities.length,
          top: opportunities.slice(0, 3),
        };
      } catch (e) {
        story_opportunities = null;
        story_opportunities_warning = `Failed to parse story opportunities JSON: ${e.message}`;
      }
    } else {
      story_opportunities = null;
      story_opportunities_warning = 'No data available for today';
    }
  } else {
    story_opportunities = null;
    story_opportunities_warning = `Story opportunities fetch failed: ${storyOppsResult.reason?.message || storyOppsResult.reason}`;
  }
  if (story_opportunities_warning) {
    warnings.push({ section: 'story_opportunities', message: story_opportunities_warning });
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
  }

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
    historical,
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
    sections_ok: 7 - warnings.length,
    sections_warned: warnings.length,
  });

  return digest;
}
