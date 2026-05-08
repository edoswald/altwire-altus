/**
 * Combined Matomo + Google Search Console synthesis.
 *
 * Pulls fresh signals from both providers for a given date range,
 * cross-references them (which articles get both impressions and pageviews,
 * search-driven traffic share, opportunity-zone × on-site interest gaps),
 * and optionally runs a Sonnet synthesis pass for narrative insight.
 *
 * Used by:
 *   - get_altwire_combined_analytics MCP tool
 *   - nightly altus-reflection cron (to write hal:altwire:combined_synthesis memory)
 *
 * Environment:
 *   ALTWIRE_MATOMO_*           — Matomo client envs
 *   ALTWIRE_GSC_*              — GSC client envs
 *   ANTHROPIC_API_KEY          — optional, enables Sonnet synthesis pass
 */

import Anthropic from '@anthropic-ai/sdk';
import { normalizeTopArticles } from '../lib/matomo-utils.js';
import { logger } from '../logger.js';
import { readAgentMemory } from '../lib/altus-db.js';
import {
  getTrafficSummary,
  getTopArticles,
  getReferrerBreakdown,
  getSiteSearchKeywords,
} from './altwire-matomo-client.js';
import {
  getSearchPerformance,
  getSearchOpportunities,
  getOpportunityZoneQueries,
} from './altwire-gsc-client.js';

const HISTORICAL_KEYS = [
  'hal:altwire:analytics:traffic_summary',
  'hal:altwire:analytics:top_articles_18m',
  'hal:altwire:analytics:topic_trends',
  'hal:altwire:analytics:search_keywords_18m',
  'hal:altwire:gsc:summary_16m',
  'hal:altwire:gsc:opportunities_16m',
];

function isoDateOffset(daysBack) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

function matomoDateRange(startDate, endDate) {
  return `${startDate},${endDate}`;
}

function normalizeUrl(u) {
  if (typeof u !== 'string') return u;
  return u.replace(/\/+$/, '').toLowerCase();
}

/**
 * Cross-reference Matomo top articles with GSC top pages.
 * Returns articles ranked by combined visibility (pageviews + impressions).
 */
function buildCrossReference(matomoTopArticles, gscPagePerformance) {
  const byUrl = new Map();

  for (const a of matomoTopArticles || []) {
    const url = normalizeUrl(a.url ?? a.label);
    if (!url) continue;
    byUrl.set(url, {
      url: a.url ?? a.label,
      title: a.label ?? a.url,
      pageviews: a.pageviews ?? a.nb_hits ?? a.nb_visits ?? 0,
      impressions: 0,
      clicks: 0,
      position: null,
      ctr: null,
    });
  }

  for (const row of gscPagePerformance || []) {
    const url = normalizeUrl(row.keys?.[0]);
    if (!url) continue;
    const existing = byUrl.get(url) ?? {
      url: row.keys[0],
      title: row.keys[0],
      pageviews: 0,
    };
    existing.impressions = row.impressions ?? 0;
    existing.clicks = row.clicks ?? 0;
    existing.position = row.position ?? null;
    existing.ctr = row.ctr ?? null;
    byUrl.set(url, existing);
  }

  return [...byUrl.values()]
    .map((r) => ({
      ...r,
      combined_score: (r.pageviews ?? 0) + (r.impressions ?? 0) * 0.1,
    }))
    .sort((a, b) => b.combined_score - a.combined_score)
    .slice(0, 15);
}

/**
 * Find search-demand-vs-coverage gaps:
 * GSC opportunity-zone queries with NO matching internal Matomo search keyword.
 */
function buildSearchGaps(opportunityZone, siteSearchKeywords) {
  const internalSet = new Set(
    (siteSearchKeywords || [])
      .map((k) => (k.label ?? k.keyword ?? '').toLowerCase().trim())
      .filter(Boolean)
  );

  const oppRows = opportunityZone?.rows ?? [];
  const gaps = [];
  for (const row of oppRows) {
    const query = (row.keys?.[0] ?? '').toLowerCase().trim();
    if (!query) continue;
    const internalMatch = [...internalSet].some((k) => k.includes(query) || query.includes(k));
    if (!internalMatch) {
      gaps.push({
        query: row.keys[0],
        impressions: row.impressions,
        position: row.position,
        page: row.keys[1] ?? null,
      });
    }
  }
  return gaps.slice(0, 20);
}

async function loadHistoricalContext() {
  const ctx = {};
  for (const key of HISTORICAL_KEYS) {
    const r = await readAgentMemory('hal', key);
    if (r.success) {
      try { ctx[key] = JSON.parse(r.value); } catch { ctx[key] = r.value; }
    }
  }
  return ctx;
}

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const SYNTHESIS_TOOL = {
  name: 'record_synthesis',
  description: 'Record the combined Matomo + GSC editorial synthesis for AltWire.',
  input_schema: {
    type: 'object',
    properties: {
      headline: {
        type: 'string',
        description: '1-sentence summary of organic + on-site performance for the period',
      },
      search_traffic_share_pct: {
        type: 'number',
        description: 'Estimated % of pageviews driven by organic search',
      },
      top_dual_winners: {
        type: 'array',
        description: 'Top 3 articles strong in BOTH pageviews AND search impressions',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            why: { type: 'string' },
          },
          required: ['url', 'title', 'why'],
        },
      },
      underperforming_in_search: {
        type: 'array',
        description: 'Top 3 articles popular on-site but weak in GSC — indexing/SEO gaps',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            why: { type: 'string' },
          },
          required: ['url', 'title', 'why'],
        },
      },
      opportunity_alignments: {
        type: 'array',
        description: 'Top 3 GSC opportunity-zone queries that align with reader interest signals',
        items: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            page: { type: 'string' },
            recommendation: { type: 'string' },
          },
          required: ['query', 'page', 'recommendation'],
        },
      },
      content_gaps: {
        type: 'array',
        description: 'Top 3 GSC searches with no on-site coverage signal',
        items: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            impressions: { type: 'number' },
            rationale: { type: 'string' },
          },
          required: ['query', 'impressions', 'rationale'],
        },
      },
      editorial_recommendation: {
        type: 'string',
        description: '2-3 sentences: what to publish, optimize, or amplify next',
      },
    },
    required: [
      'headline',
      'search_traffic_share_pct',
      'top_dual_winners',
      'underperforming_in_search',
      'opportunity_alignments',
      'content_gaps',
      'editorial_recommendation',
    ],
  },
};

async function synthesize(payload) {
  if (!anthropic) return null;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      temperature: 0.3,
      system: `You are an editorial analytics strategist for AltWire (a music & lifestyle publication).
You synthesize Matomo on-site behavior and Google Search Console organic visibility into a unified, actionable picture.
Be specific and cite numbers, articles, and queries.
AltWire publishes content in multiple languages — URLs containing /de/, /fr/, /ru/ etc. are localized versions targeting non-English audiences. Treat their traffic as a distinct international readership signal, not as duplicates of English originals.`,
      tools: [SYNTHESIS_TOOL],
      tool_choice: { type: 'any' },
      messages: [
        {
          role: 'user',
          content: `Synthesize the following Matomo + GSC data for AltWire and call the record_synthesis tool with your analysis:

${JSON.stringify(payload, null, 2)}`,
        },
      ],
    });

    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === 'record_synthesis');
    if (!toolUse) {
      logger.warn('combined-analytics: synthesis tool not called', {
        stop_reason: response.stop_reason,
        content_types: response.content.map((b) => b.type),
      });
      return null;
    }
    return toolUse.input;
  } catch (err) {
    logger.warn('combined-analytics: synthesis failed', { error: err.message });
    return null;
  }
}

/**
 * Pull fresh Matomo + GSC signals for a date range and synthesize.
 *
 * @param {object} [opts]
 * @param {string} [opts.startDate] ISO date — default 28 days ago
 * @param {string} [opts.endDate]   ISO date — default 3 days ago (GSC lag aware)
 * @param {boolean} [opts.synthesize=true]
 * @returns {Promise<object>}
 */
export async function getCombinedAnalytics(opts = {}) {
  const endDate = opts.endDate ?? isoDateOffset(3);
  const startDate = opts.startDate ?? isoDateOffset(31);
  const doSynth = opts.synthesize !== false;

  logger.info('combined-analytics: fetching', { startDate, endDate });

  const matomoDate = matomoDateRange(startDate, endDate);

  const [
    trafficResult,
    topArticlesResult,
    referrerResult,
    siteSearchResult,
    gscPerfResult,
    gscOppsResult,
    gscOppZoneResult,
    gscPagePerfResult,
  ] = await Promise.allSettled([
    getTrafficSummary('range', matomoDate),
    getTopArticles('range', matomoDate, 20),
    getReferrerBreakdown('range', matomoDate),
    getSiteSearchKeywords('range', matomoDate),
    getSearchPerformance(startDate, endDate, { rowLimit: 50, dimensions: ['query'] }),
    getSearchOpportunities(startDate, endDate),
    getOpportunityZoneQueries(startDate, endDate),
    getSearchPerformance(startDate, endDate, { rowLimit: 50, dimensions: ['page'] }),
  ]);

  const v = (r) => (r.status === 'fulfilled' ? r.value : { error: r.reason?.message });
  const wpBase = process.env.ALTWIRE_WP_URL ?? 'https://altwire.net';
  const rawTopArticles = v(topArticlesResult);
  const matomo = {
    traffic: v(trafficResult),
    top_articles: Array.isArray(rawTopArticles)
      ? normalizeTopArticles(rawTopArticles, wpBase)
      : rawTopArticles,
    referrers: v(referrerResult),
    site_search: v(siteSearchResult),
  };
  const gsc = {
    top_queries: v(gscPerfResult),
    opportunities: v(gscOppsResult),
    opportunity_zone: v(gscOppZoneResult),
    page_performance: v(gscPagePerfResult),
  };

  const matomoConfigured = !matomo.traffic?.error;
  const gscConfigured = !gsc.top_queries?.error;

  // Cross-references (only meaningful if both sides returned data)
  const topArticlesArr = Array.isArray(matomo.top_articles) ? matomo.top_articles : [];
  const gscPageRows = gsc.page_performance?.rows ?? [];
  const cross_reference = matomoConfigured && gscConfigured
    ? buildCrossReference(topArticlesArr, gscPageRows)
    : [];

  const search_gaps = matomoConfigured && gscConfigured
    ? buildSearchGaps(gsc.opportunity_zone, Array.isArray(matomo.site_search) ? matomo.site_search : [])
    : [];

  // Search-driven traffic share estimate (referrer-based)
  let search_traffic_share_pct = null;
  if (matomo.referrers?.types) {
    const types = matomo.referrers.types;
    const totalVisits = types.reduce((s, t) => s + (t.nb_visits ?? 0), 0);
    const searchVisits = types
      .filter((t) => (t.label ?? '').toLowerCase().includes('search'))
      .reduce((s, t) => s + (t.nb_visits ?? 0), 0);
    if (totalVisits > 0) {
      search_traffic_share_pct = Math.round((searchVisits / totalVisits) * 100);
    }
  }

  const historical = await loadHistoricalContext();

  const baseline = {
    period: { start_date: startDate, end_date: endDate },
    configured: { matomo: matomoConfigured, gsc: gscConfigured },
    matomo,
    gsc,
    cross_reference,
    search_gaps,
    search_traffic_share_pct,
    historical_keys_loaded: Object.keys(historical),
  };

  let synthesis = null;
  if (doSynth && (matomoConfigured || gscConfigured)) {
    const synthPayload = {
      period: { start_date: startDate, end_date: endDate },
      search_traffic_share_pct,
      traffic_summary: {
        nb_visits: matomo.traffic?.nb_visits ?? null,
        nb_pageviews: matomo.traffic?.nb_pageviews ?? null,
        bounce_rate: matomo.traffic?.bounce_rate ?? null,
      },
      top_articles: topArticlesArr.slice(0, 10).map((a) => ({
        url: a.url ?? a.label,
        label: a.label ?? a.title ?? a.url,
      pageviews: a.pageviews ?? a.nb_hits ?? a.nb_visits ?? 0,
      })),
      top_queries: (gsc.top_queries?.rows ?? []).slice(0, 10).map((r) => ({
        query: r.keys?.[0],
        impressions: r.impressions,
        clicks: r.clicks,
        position: r.position,
        ctr: r.ctr,
      })),
      top_opportunities: (gsc.opportunities?.opportunities ?? []).slice(0, 10),
      cross_reference: cross_reference.slice(0, 10),
      search_gaps: search_gaps.slice(0, 10),
      historical_summary: {
        gsc_16m_insights: historical['hal:altwire:gsc:summary_16m']?.insights ?? null,
        gsc_16m_trend: historical['hal:altwire:gsc:summary_16m']?.trend_direction ?? null,
        traffic_trend: historical['hal:altwire:analytics:traffic_summary']?.trend_direction ?? null,
        rising_topics: historical['hal:altwire:analytics:topic_trends']?.rising_topics?.slice(0, 3) ?? null,
      },
    };
    synthesis = await synthesize(synthPayload);
  }

  return {
    ...baseline,
    synthesis,
    generated_at: new Date().toISOString(),
  };
}
