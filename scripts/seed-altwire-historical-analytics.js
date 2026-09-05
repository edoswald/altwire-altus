/**
 * scripts/seed-altwire-historical-analytics.js
 *
 * Fetches 18 months of AltWire Matomo data, analyzes it via LLM,
 * and writes summarized editorial intelligence to agent_memory.
 *
 * Two-pass analysis:
 *   Pass 1 — Minimax: bulk summarization across all 8 memory keys
 *   Pass 2 — Sonnet:   editorial-quality refinement of traffic_summary + topic_trends
 *
 * Idempotent. Safe to re-run with --force.
 *
 * When MINIMAX_API_KEY is not configured (or --no-llm is passed) the script
 * falls back to a deterministic analysis pass that computes the same memory-key
 * schema directly from the aggregated Matomo data — no LLM required. This keeps
 * the Hal analytics drawer populated even without an LLM provisioned.
 *
 * Usage:
 *   node scripts/seed-altwire-historical-analytics.js          # normal run (skip if < 30 days old)
 *   node scripts/seed-altwire-historical-analytics.js --force  # force full re-fetch
 *   node scripts/seed-altwire-historical-analytics.js --no-llm # deterministic, no LLM calls
 *
 * Environment:
 *   ALTWIRE_DATABASE_URL         — AltWire PostgreSQL
 *   ALTWIRE_MATOMO_URL           — e.g. https://matomo.altwire.net
 *   ALTWIRE_MATOMO_TOKEN_AUTH    — Matomo API token
 *   ALTWIRE_MATOMO_SITE_ID       — Matomo site ID
 *   MINIMAX_API_KEY              — Minimax API key (required unless --no-llm / deterministic fallback)
 *   ANTHROPIC_API_KEY            — Anthropic API key for Sonnet critic pass (required unless --no-llm)
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import pool from '../lib/altus-db.js';
import { writeAgentMemory, readAgentMemory } from '../lib/altus-db.js';
import { withCachedSystem } from '../lib/anthropic-cache.js';
import {
  getTrafficSummary,
  getTopArticles,
  getReferrerBreakdown,
  getSiteSearchKeywords,
} from '../handlers/altwire-matomo-client.js';

const TZ = 'America/New_York';
const AGENT = 'hal';

const MEMORY_KEYS = {
  TRAFFIC_SUMMARY:         'hal:altwire:analytics:traffic_summary',
  TOP_ARTICLES:            'hal:altwire:analytics:top_articles_18m',
  ARTICLE_TYPE_PERF:        'hal:altwire:analytics:article_type_performance',
  TOPIC_TRENDS:            'hal:altwire:analytics:topic_trends',
  REFERRER_SUMMARY:        'hal:altwire:analytics:referrer_summary',
  SEARCH_KEYWORDS:         'hal:altwire:analytics:search_keywords_18m',
  SEASONALITY:             'hal:altwire:analytics:seasonality',
  LAST_REFRESHED:          'hal:altwire:analytics:last_refreshed',
};

const DEFAULT_START_DATE = '2024-12-01';

const log = (msg, data = {}) => console.log(`[seed-historical] ${msg}`, JSON.stringify(data));

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function toET(date) {
  return toZonedTime(date, TZ);
}

function formatDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateRange(startDate, endDate) {
  const dates = [];
  const cur = new Date(startDate);
  const end = new Date(endDate);
  while (cur < end) {
    dates.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function validateConfig({ noLlm } = {}) {
  const missing = [];
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) missing.push('ALTWIRE_DATABASE_URL');
  if (!process.env.ALTWIRE_MATOMO_URL) missing.push('ALTWIRE_MATOMO_URL');
  if (!process.env.ALTWIRE_MATOMO_TOKEN_AUTH) missing.push('ALTWIRE_MATOMO_TOKEN_AUTH');
  if (!process.env.ALTWIRE_MATOMO_SITE_ID) missing.push('ALTWIRE_MATOMO_SITE_ID');
  // LLM is optional: Minimax preferred, Anthropic fallback, deterministic last resort.
  if (!noLlm && !process.env.MINIMAX_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    missing.push('MINIMAX_API_KEY or ANTHROPIC_API_KEY (or run with --no-llm)');
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Check refresh eligibility
// ---------------------------------------------------------------------------

async function getLastRefreshed() {
  const result = await readAgentMemory(AGENT, MEMORY_KEYS.LAST_REFRESHED);
  if (!result.success) return null;
  try {
    return new Date(JSON.parse(result.value).timestamp);
  } catch {
    return null;
  }
}

async function shouldRefresh(force) {
  if (force) return true;
  const last = await getLastRefreshed();
  if (!last) return true;
  const ageMs = Date.now() - last.getTime();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  return ageMs > THIRTY_DAYS_MS;
}

// ---------------------------------------------------------------------------
// Phase 1: Data fetching
// ---------------------------------------------------------------------------

async function fetchDailySummaries(startDate, endDate) {
  const dates = dateRange(startDate, endDate);
  const now = new Date();
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const dailyData = [];
  const weeklyData = [];

  const dailyDates = dates.filter((d) => d >= ninetyDaysAgo);
  const weeklyDates = dates.filter((d) => d < ninetyDaysAgo);

  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 200;

  log(`Fetching ${dailyDates.length} daily summaries + ${weeklyDates.length} weekly summaries`);

  // Daily batches (last 90 days)
  for (const chunk of chunkArray(dailyDates, BATCH_SIZE)) {
    const results = await Promise.allSettled(
      chunk.map((d) => getTrafficSummary('day', formatDate(d)))
    );
    for (let i = 0; i < chunk.length; i++) {
      const res = results[i];
      const d = chunk[i];
      if (res.status === 'fulfilled' && !res.value.error) {
        const r = res.value;
        dailyData.push({
          date: formatDate(d),
          visits: r.nb_visits ?? 0,
          pageviews: r.nb_pageviews ?? 0,
          bounce_rate: r.bounce_rate ?? null,
        });
      }
    }
    await delay(BATCH_DELAY_MS);
  }

  // Weekly aggregates for older dates
  const weekChunks = chunkArray(weeklyDates, BATCH_SIZE);
  for (const chunk of weekChunks) {
    const results = await Promise.allSettled(
      chunk.map((d) => getTrafficSummary('week', formatDate(d)))
    );
    for (let i = 0; i < chunk.length; i++) {
      const res = results[i];
      const d = chunk[i];
      if (res.status === 'fulfilled' && !res.value.error) {
        const r = res.value;
        weeklyData.push({
          week_start: formatDate(d),
          visits: r.nb_visits ?? 0,
          pageviews: r.nb_pageviews ?? 0,
          bounce_rate: r.bounce_rate ?? null,
        });
      }
    }
    await delay(BATCH_DELAY_MS);
  }

  log(`Fetched ${dailyData.length} daily rows, ${weeklyData.length} weekly rows`);
  return { dailyData, weeklyData };
}

async function fetchTopArticlesByMonth(startDate, endDate) {
  const now = new Date();
  const months = [];
  const cur = new Date(startDate);
  while (cur < endDate) {
    months.push(new Date(cur.getFullYear(), cur.getMonth(), 1));
    cur.setMonth(cur.getMonth() + 1);
  }

  const articlesByMonth = [];
  const BATCH_DELAY_MS = 150;

  for (const month of months) {
    const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const dateStr = `${formatDate(month)},${formatDate(lastDay)}`;
    const result = await getTopArticles('range', dateStr, 20).catch(() => []);
    if (Array.isArray(result) && !result.error) {
      articlesByMonth.push({
        month: formatDate(month),
        articles: result.map((r) => ({
          url: r.url ?? r.label ?? '',
          label: r.label ?? r.url ?? '',
          pageviews: typeof r.nb_hits === 'number' ? r.nb_hits : 0,
        })),
      });
    }
    await delay(BATCH_DELAY_MS);
  }

  log(`Fetched top articles for ${articlesByMonth.length} months`);
  return articlesByMonth;
}

async function fetchReferrerBreakdowns(startDate, endDate) {
  const now = new Date();
  const months = [];
  const cur = new Date(startDate);
  while (cur < endDate) {
    months.push(new Date(cur.getFullYear(), cur.getMonth(), 1));
    cur.setMonth(cur.getMonth() + 1);
  }

  const breakdowns = [];
  const BATCH_DELAY_MS = 150;

  for (const month of months) {
    const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const dateStr = `${formatDate(month)},${formatDate(lastDay)}`;
    const result = await getReferrerBreakdown('range', dateStr).catch(() => null);
    if (result && !result.types?.error) {
      breakdowns.push({ month: formatDate(month), ...result });
    }
    await delay(BATCH_DELAY_MS);
  }

  log(`Fetched referrer breakdowns for ${breakdowns.length} months`);
  return breakdowns;
}

async function fetchSearchKeywords(startDate, endDate) {
  const now = new Date();
  const months = [];
  const cur = new Date(startDate);
  while (cur < endDate) {
    months.push(new Date(cur.getFullYear(), cur.getMonth(), 1));
    cur.setMonth(cur.getMonth() + 1);
  }

  const keywordsByMonth = [];
  const BATCH_DELAY_MS = 150;

  for (const month of months) {
    const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const dateStr = `${formatDate(month)},${formatDate(lastDay)}`;
    const result = await getSiteSearchKeywords('range', dateStr).catch(() => []);
    if (Array.isArray(result) && !result.error) {
      keywordsByMonth.push({
        month: formatDate(month),
        keywords: result.slice(0, 20).map((r) => ({
          keyword: r.label ?? r.keyword ?? '',
          hits: typeof r.nb_visits === 'number' ? r.nb_visits : 0,
        })),
      });
    }
    await delay(BATCH_DELAY_MS);
  }

  log(`Fetched search keywords for ${keywordsByMonth.length} months`);
  return keywordsByMonth;
}

async function fetchPostMetadata(limit = 200) {
  try {
    const { rows } = await pool.query(
      `SELECT url, title, slug, published_at, categories, content_type
       FROM altus_content
       WHERE content_type = 'post' AND url IS NOT NULL
       ORDER BY published_at DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  } catch (err) {
    log('fetchPostMetadata: DB query failed', { error: err.message });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 2: LLM Analysis — Minimax Pass
// ---------------------------------------------------------------------------

// Lazily constructed so the script can run in deterministic / Anthropic-only
// modes without a Minimax key (the OpenAI SDK throws at construction when no
// apiKey is resolvable).
let _minimaxClient = null;
function getMinimaxClient() {
  if (!_minimaxClient) {
    _minimaxClient = new OpenAI({
      apiKey: process.env.MINIMAX_API_KEY,
      baseURL: 'https://api.minimax.io/v1',
    });
  }
  return _minimaxClient;
}

const ANALYSIS_MODEL = 'MiniMax-M2.7';
const ANALYSIS_FALLBACK_MODEL = 'claude-sonnet-4-6';

const ANALYSIS_SYSTEM_PROMPT = `You are an editorial data analyst for AltWire, a music and lifestyle publication.
Given structured analytics data about the publication's traffic over 18 months, produce concise, actionable
analysis summaries. Output valid JSON only — no markdown, no explanation outside the JSON.

Output schema for each key is provided in the user prompt. Follow it exactly.
Be specific: cite actual numbers, article titles, months, and trends.`;

// Analysis engine: prefer Minimax when configured, otherwise route through the
// normal Anthropic flow (ANTHROPIC_API_KEY). Falls back to deterministic
// builders only when neither is available (see main()).
async function llmAnalyze(prompt) {
  if (process.env.MINIMAX_API_KEY) {
    const response = await getMinimaxClient().chat.completions.create({
      model: ANALYSIS_MODEL,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    });
    return response.choices[0]?.message?.content ?? '';
  }

  // Anthropic fallback
  const response = await getAnthropicClient().messages.create({
    model: ANALYSIS_FALLBACK_MODEL,
    max_tokens: 4000,
    temperature: 0.3,
    // ANALYSIS_SYSTEM_PROMPT is stable across every 18-month analysis call —
    // wrapped so repeated sections of this seeded run hit the cache.
    system: withCachedSystem(ANALYSIS_SYSTEM_PROMPT),
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0]?.type === 'text' ? response.content[0].text : '';
}

function parseJsonResponse(raw) {
  const trimmed = raw.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('No JSON object found in response');
  }
  return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
}

// ---------------------------------------------------------------------------
// Minimax analysis functions
// ---------------------------------------------------------------------------

async function analyzeTrafficSummary(dailyData, weeklyData) {
  const prompt = `You are analyzing 18 months of daily and weekly traffic data for AltWire.net.

Data (last 90 days, daily):
${JSON.stringify(dailyData.slice(0, 90))}

Data (older dates, weekly aggregate — multiply by 7 for rough weekly totals):
${JSON.stringify(weeklyData.slice(0, 52))}

Produce a JSON object with:
{
  "total_pageviews": number,
  "total_visits": number,
  "avg_monthly_pageviews": number,
  "avg_monthly_visits": number,
  "peak_month": string (YYYY-MM),
  "peak_month_pageviews": number,
  "trend_direction": "rising" | "stable" | "declining",
  "trendEvidence": string (2-3 sentences citing specific month-over-month changes),
  "monthly_breakdown": [{month: string, pageviews: number, visits: number}, ...] (sorted oldest to newest)
}
Return only the JSON object.`;

  const raw = await llmAnalyze(prompt);
  return parseJsonResponse(raw);
}

async function analyzeTopArticles(articlesByMonth, posts) {
  const urlToMeta = new Map(posts.map((p) => [p.url, p]));
  const flat = [];
  for (const monthData of articlesByMonth) {
    for (const article of monthData.articles) {
      const url = article.url?.startsWith('http') ? article.url : null;
      const meta = url ? urlToMeta.get(url) : null;
      flat.push({
        url: article.url,
        title: meta?.title ?? article.label ?? article.url,
        categories: meta?.categories ?? [],
        month: monthData.month,
        pageviews: article.pageviews,
      });
    }
  }

  const byUrl = new Map();
  for (const a of flat) {
    if (!byUrl.has(a.url)) byUrl.set(a.url, { ...a });
    else byUrl.get(a.url).pageviews += a.pageviews;
  }
  const top20 = [...byUrl.values()].sort((a, b) => b.pageviews - a.pageviews).slice(0, 20);

  const prompt = `You are analyzing 18 months of article performance for AltWire.net.

Top articles by URL (aggregated pageviews across all months):
${JSON.stringify(top20)}

Provide a JSON object:
{
  "all_time_top_10": [{rank: 1-10, url: string, title: string, total_pageviews: number, first_month_seen: string, categories: string[]}, ...],
  "insights": string (2-3 sentences about what makes these articles perform well — topic, type, timing)
}
Return only the JSON object.`;

  const raw = await llmAnalyze(prompt);
  return parseJsonResponse(raw);
}

async function analyzeArticleTypePerformance(articlesByMonth, posts) {
  const urlToMeta = new Map(posts.map((p) => [p.url, p]));
  const byType = { review: 0, interview: 0, feature: 0, listicle: 0, news: 0, other: 0 };

  for (const monthData of articlesByMonth) {
    for (const article of monthData.articles) {
      const url = article.url?.startsWith('http') ? article.url : null;
      const meta = url ? urlToMeta.get(url) : null;
      const cats = meta?.categories ?? [];
      const catStr = cats.join(' ').toLowerCase();
      let type = 'other';
      if (catStr.includes('review')) type = 'review';
      else if (catStr.includes('interview')) type = 'interview';
      else if (catStr.includes('feature')) type = 'feature';
      else if (catStr.includes('listicle') || catStr.includes('list')) type = 'listicle';
      else if (catStr.includes('news')) type = 'news';
      byType[type] += article.pageviews;
    }
  }

  const prompt = `You are analyzing 18 months of article performance grouped by content type for AltWire.net.

Pageviews by type (raw totals):
${JSON.stringify(byType)}

Provide a JSON object:
{
  "type_breakdown": {review: number, interview: number, feature: number, listicle: number, news: number, other: number},
  "type_percentages": {review: string, interview: string, feature: string, listicle: string, news: string, other: string},
  "best_performing_type": string,
  "insights": string (2-3 sentences about type performance and what it implies for editorial strategy)
}
Return only the JSON object.`;

  const raw = await llmAnalyze(prompt);
  return parseJsonResponse(raw);
}

async function analyzeTopicTrends(articlesByMonth, posts) {
  const urlToMeta = new Map(posts.map((p) => [p.url, p]));
  const topicData = new Map();

  for (const monthData of articlesByMonth) {
    for (const article of monthData.articles) {
      const url = article.url?.startsWith('http') ? article.url : null;
      const meta = url ? urlToMeta.get(url) : null;
      const cats = meta?.categories ?? [];
      for (const cat of cats) {
        if (!topicData.has(cat)) topicData.set(cat, []);
        topicData.get(cat).push({ month: monthData.month, pageviews: article.pageviews });
      }
    }
  }

  const topicTrends = [];
  for (const [topic, months] of topicData) {
    const totalPv = months.reduce((s, m) => s + m.pageviews, 0);
    const avgPv = totalPv / months.length;
    const recentMonths = months.slice(-3);
    const olderMonths = months.slice(-6, -3);
    const recentAvg = recentMonths.length > 0 ? recentMonths.reduce((s, m) => s + m.pageviews, 0) / recentMonths.length : 0;
    const olderAvg = olderMonths.length > 0 ? olderMonths.reduce((s, m) => s + m.pageviews, 0) / olderMonths.length : 0;
    const trend = olderAvg > 0 ? (recentAvg - olderAvg) / olderAvg : 0;
    topicTrends.push({ topic, total_pageviews: totalPv, avg_monthly: Math.round(avgPv), trend_pct: Math.round(trend * 100) });
  }

  const topTopics = topicTrends.sort((a, b) => b.total_pageviews - a.total_pageviews).slice(0, 15);

  const prompt = `You are analyzing 18 months of topic/trend performance for AltWire.net.

Topic performance (top 15 by total pageviews):
${JSON.stringify(topTopics)}

Provide a JSON object:
{
  "rising_topics": [{topic: string, trend_pct: number, avg_monthly: number}, ...] (sorted by trend_pct desc, top 5),
  "stable_topics": [{topic: string, trend_pct: number, avg_monthly: number}, ...] (trend between -10 and +10, top 5),
  "declining_topics": [{topic: string, trend_pct: number, avg_monthly: number}, ...] (sorted by trend_pct asc, top 5),
  "insights": string (2-3 sentences about content gaps, emerging topics, and editorial opportunities)
}
Return only the JSON object.`;

  const raw = await llmAnalyze(prompt);
  return parseJsonResponse(raw);
}

async function analyzeReferrerSummary(breakdowns) {
  const summary = { direct: 0, search: 0, social: 0, campaigns: 0, websites: 0 };
  const topSources = [];

  for (const bd of breakdowns) {
    const types = bd.types;
    if (types) {
      for (const t of types) {
        const label = t.label ?? '';
        const visits = typeof t.nb_visits === 'number' ? t.nb_visits : 0;
        if (label.includes('direct')) summary.direct += visits;
        else if (label.includes('search')) summary.search += visits;
        else if (label.includes('social')) summary.social += visits;
        else if (label.includes('campaign')) summary.campaigns += visits;
        else summary.websites += visits;
        topSources.push({ label, visits });
      }
    }
  }

  const topReferrers = [...new Map(topSources.map((s) => [s.label, s])).values()]
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 10);

  const prompt = `You are analyzing 18 months of referrer traffic for AltWire.net.

Aggregate referrer totals:
${JSON.stringify(summary)}

Top 10 referrer sources by visits:
${JSON.stringify(topReferrers)}

Provide a JSON object:
{
  "referrer_breakdown": {direct: number, search: number, social: number, campaigns: number, websites: number},
  "referrer_percentages": {direct: string, search: string, social: string, campaigns: string, websites: string},
  "top_sources": [{label: string, visits: number}, ...] (top 10, sorted by visits desc),
  "insights": string (2-3 sentences about audience acquisition patterns)
}
Return only the JSON object.`;

  const raw = await llmAnalyze(prompt);
  return parseJsonResponse(raw);
}

async function analyzeSearchKeywords(keywordsByMonth) {
  const allKeywords = [];
  for (const km of keywordsByMonth) {
    for (const kw of km.keywords) {
      allKeywords.push({ ...kw, month: km.month });
    }
  }

  const byKw = new Map();
  for (const kw of allKeywords) {
    if (!byKw.has(kw.keyword)) byKw.set(kw.keyword, { keyword: kw.keyword, total_hits: 0, months: [] });
    byKw.get(kw.keyword).total_hits += kw.hits;
    byKw.get(kw.keyword).months.push(kw.month);
  }

  const topKeywords = [...byKw.values()].sort((a, b) => b.total_hits - a.total_hits).slice(0, 30);

  const prompt = `You are analyzing 18 months of internal site search keywords for AltWire.net.

Top 30 keywords by total hits:
${JSON.stringify(topKeywords)}

Provide a JSON object:
{
  "top_keywords": [{keyword: string, total_hits: number, months_active: number}, ...] (sorted by total_hits desc, top 20),
  "insights": string (2-3 sentences about what readers are searching for and content gaps this reveals)
}
Return only the JSON object.`;

  const raw = await llmAnalyze(prompt);
  return parseJsonResponse(raw);
}

async function analyzeSeasonality(dailyData) {
  const prompt = `You are analyzing 18 months of daily traffic data for AltWire.net to identify seasonality patterns.

Daily data sample (up to 365 days):
${JSON.stringify(dailyData.slice(0, 365))}

Provide a JSON object:
{
  "day_of_week_pattern": {avg_pageviews_by_day: {monday: number, tuesday: number, ..., sunday: number}},
  "monthly_pattern": {avg_pageviews_by_month: {"01": number, "02": number, ..., "12": number}},
  "peak_season": string (e.g. "summer months" or "December holiday season"),
  "low_season": string,
  "insights": string (2-3 sentences about editorial calendar implications — when to publish more, when to plan ahead)
}
Return only the JSON object.`;

  const raw = await llmAnalyze(prompt);
  return parseJsonResponse(raw);
}

// ---------------------------------------------------------------------------
// Deterministic (no-LLM) builders
//
// Produce the same JSON schema as the LLM analysis passes, computed purely from
// the aggregated Matomo data. Used when neither MINIMAX_API_KEY nor
// ANTHROPIC_API_KEY is configured (or --no-llm is passed), so the seed can still
// populate agent_memory and the Hal analytics drawer without any LLM.
// ---------------------------------------------------------------------------

const monthKey = (dateStr) => (typeof dateStr === 'string' ? dateStr.slice(0, 7) : '');
const pctOf = (part, total) => (total > 0 ? `${Math.round((part / total) * 1000) / 10}%` : '0%');

function buildTrafficSummaryDeterministic(dailyData, weeklyData) {
  const byMonth = new Map();
  const add = (dateStr, pv, v) => {
    const m = monthKey(dateStr);
    if (!m) return;
    if (!byMonth.has(m)) byMonth.set(m, { month: m, pageviews: 0, visits: 0 });
    const row = byMonth.get(m);
    row.pageviews += pv || 0;
    row.visits += v || 0;
  };
  for (const d of dailyData) add(d.date, d.pageviews, d.visits);
  for (const w of weeklyData) add(w.week_start, w.pageviews, w.visits);

  const monthly_breakdown = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  const total_pageviews = monthly_breakdown.reduce((s, m) => s + m.pageviews, 0);
  const total_visits = monthly_breakdown.reduce((s, m) => s + m.visits, 0);
  const numMonths = monthly_breakdown.length || 1;

  let peak = { month: null, pageviews: 0 };
  for (const m of monthly_breakdown) if (m.pageviews > peak.pageviews) peak = { month: m.month, pageviews: m.pageviews };

  const avg = (arr) => (arr.length ? arr.reduce((s, m) => s + m.pageviews, 0) / arr.length : 0);
  const recentAvg = avg(monthly_breakdown.slice(-3));
  const priorAvg = avg(monthly_breakdown.slice(-6, -3));
  let trend_direction = 'stable';
  if (priorAvg > 0) {
    const change = (recentAvg - priorAvg) / priorAvg;
    if (change > 0.1) trend_direction = 'rising';
    else if (change < -0.1) trend_direction = 'declining';
  }

  return {
    total_pageviews,
    total_visits,
    avg_monthly_pageviews: Math.round(total_pageviews / numMonths),
    avg_monthly_visits: Math.round(total_visits / numMonths),
    peak_month: peak.month,
    peak_month_pageviews: peak.pageviews,
    trend_direction,
    trendEvidence: `Computed from ${numMonths} months of Matomo data. Recent 3-month average ${Math.round(recentAvg)} pageviews/month vs ${Math.round(priorAvg)} in the prior 3 months.`,
    monthly_breakdown,
    generated_without_llm: true,
  };
}

function buildTopArticlesDeterministic(articlesByMonth, posts) {
  const urlToMeta = new Map(posts.map((p) => [p.url, p]));
  const byUrl = new Map();
  for (const monthData of articlesByMonth) {
    for (const article of monthData.articles) {
      const url = article.url;
      if (!url) continue;
      const meta = url.startsWith('http') ? urlToMeta.get(url) : null;
      if (!byUrl.has(url)) {
        byUrl.set(url, {
          url,
          title: meta?.title ?? article.label ?? url,
          categories: meta?.categories ?? [],
          first_month_seen: monthData.month,
          total_pageviews: 0,
        });
      }
      byUrl.get(url).total_pageviews += article.pageviews || 0;
    }
  }
  const sorted = [...byUrl.values()].sort((a, b) => b.total_pageviews - a.total_pageviews);
  const all_time_top_10 = sorted.slice(0, 10).map((a, i) => ({
    rank: i + 1,
    url: a.url,
    title: a.title,
    total_pageviews: a.total_pageviews,
    first_month_seen: a.first_month_seen,
    categories: a.categories,
  }));
  return {
    all_time_top_10,
    insights: all_time_top_10.length
      ? `Top performer: "${all_time_top_10[0].title}" with ${all_time_top_10[0].total_pageviews} pageviews across the period.`
      : 'No article-level pageview data available for the period.',
    generated_without_llm: true,
  };
}

function buildArticleTypePerformanceDeterministic(articlesByMonth, posts) {
  const urlToMeta = new Map(posts.map((p) => [p.url, p]));
  const byType = { review: 0, interview: 0, feature: 0, listicle: 0, news: 0, other: 0 };
  for (const monthData of articlesByMonth) {
    for (const article of monthData.articles) {
      const url = article.url?.startsWith('http') ? article.url : null;
      const meta = url ? urlToMeta.get(url) : null;
      const catStr = (meta?.categories ?? []).join(' ').toLowerCase();
      let type = 'other';
      if (catStr.includes('review')) type = 'review';
      else if (catStr.includes('interview')) type = 'interview';
      else if (catStr.includes('feature')) type = 'feature';
      else if (catStr.includes('listicle') || catStr.includes('list')) type = 'listicle';
      else if (catStr.includes('news')) type = 'news';
      byType[type] += article.pageviews || 0;
    }
  }
  const total = Object.values(byType).reduce((s, v) => s + v, 0);
  const type_percentages = {};
  for (const k of Object.keys(byType)) type_percentages[k] = pctOf(byType[k], total);
  let best = 'other';
  let bestVal = -1;
  for (const [k, v] of Object.entries(byType)) if (k !== 'other' && v > bestVal) { best = k; bestVal = v; }
  return {
    type_breakdown: byType,
    type_percentages,
    best_performing_type: best,
    insights: `Best performing content type by pageviews: ${best} (${type_percentages[best]} of typed traffic).`,
    generated_without_llm: true,
  };
}

function buildTopicTrendsDeterministic(articlesByMonth, posts) {
  const urlToMeta = new Map(posts.map((p) => [p.url, p]));
  const topicData = new Map();
  for (const monthData of articlesByMonth) {
    for (const article of monthData.articles) {
      const url = article.url?.startsWith('http') ? article.url : null;
      const meta = url ? urlToMeta.get(url) : null;
      for (const cat of (meta?.categories ?? [])) {
        if (!topicData.has(cat)) topicData.set(cat, []);
        topicData.get(cat).push({ month: monthData.month, pageviews: article.pageviews || 0 });
      }
    }
  }
  const trends = [];
  for (const [topic, months] of topicData) {
    const totalPv = months.reduce((s, m) => s + m.pageviews, 0);
    const avgPv = totalPv / months.length;
    const recent = months.slice(-3);
    const older = months.slice(-6, -3);
    const recentAvg = recent.length ? recent.reduce((s, m) => s + m.pageviews, 0) / recent.length : 0;
    const olderAvg = older.length ? older.reduce((s, m) => s + m.pageviews, 0) / older.length : 0;
    const trend_pct = olderAvg > 0 ? Math.round(((recentAvg - olderAvg) / olderAvg) * 100) : 0;
    trends.push({ topic, total_pageviews: totalPv, avg_monthly: Math.round(avgPv), trend_pct });
  }
  const slim = ({ topic, trend_pct, avg_monthly }) => ({ topic, trend_pct, avg_monthly });
  const rising_topics = [...trends].filter((t) => t.trend_pct > 10).sort((a, b) => b.trend_pct - a.trend_pct).slice(0, 5).map(slim);
  const declining_topics = [...trends].filter((t) => t.trend_pct < -10).sort((a, b) => a.trend_pct - b.trend_pct).slice(0, 5).map(slim);
  const stable_topics = [...trends].filter((t) => t.trend_pct >= -10 && t.trend_pct <= 10).sort((a, b) => b.avg_monthly - a.avg_monthly).slice(0, 5).map(slim);
  return {
    rising_topics,
    stable_topics,
    declining_topics,
    insights: rising_topics.length ? `Rising topics: ${rising_topics.map((t) => t.topic).join(', ')}.` : 'No clear rising topics in the period.',
    generated_without_llm: true,
  };
}

function buildReferrerSummaryDeterministic(breakdowns) {
  const summary = { direct: 0, search: 0, social: 0, campaigns: 0, websites: 0 };
  const topSources = [];
  for (const bd of breakdowns) {
    for (const t of (bd.types ?? [])) {
      const label = t.label ?? '';
      const visits = typeof t.nb_visits === 'number' ? t.nb_visits : 0;
      if (label.includes('direct')) summary.direct += visits;
      else if (label.includes('search')) summary.search += visits;
      else if (label.includes('social')) summary.social += visits;
      else if (label.includes('campaign')) summary.campaigns += visits;
      else summary.websites += visits;
      topSources.push({ label, visits });
    }
  }
  const total = Object.values(summary).reduce((s, v) => s + v, 0);
  const referrer_percentages = {};
  for (const k of Object.keys(summary)) referrer_percentages[k] = pctOf(summary[k], total);
  const top_sources = [...new Map(topSources.map((s) => [s.label, s])).values()]
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 10);
  const largest = Object.entries(summary).sort((a, b) => b[1] - a[1])[0];
  return {
    referrer_breakdown: summary,
    referrer_percentages,
    top_sources,
    insights: `Largest acquisition channel: ${largest ? largest[0] : 'n/a'} (${largest ? pctOf(largest[1], total) : '0%'}).`,
    generated_without_llm: true,
  };
}

function buildSearchKeywordsDeterministic(keywordsByMonth) {
  const byKw = new Map();
  for (const km of keywordsByMonth) {
    for (const kw of km.keywords) {
      if (!byKw.has(kw.keyword)) byKw.set(kw.keyword, { keyword: kw.keyword, total_hits: 0, months: new Set() });
      const row = byKw.get(kw.keyword);
      row.total_hits += kw.hits || 0;
      row.months.add(km.month);
    }
  }
  const top_keywords = [...byKw.values()]
    .sort((a, b) => b.total_hits - a.total_hits)
    .slice(0, 20)
    .map((k) => ({ keyword: k.keyword, total_hits: k.total_hits, months_active: k.months.size }));
  return {
    top_keywords,
    insights: top_keywords.length ? `Most searched: "${top_keywords[0].keyword}" (${top_keywords[0].total_hits} hits).` : 'No site-search data available.',
    generated_without_llm: true,
  };
}

function buildSeasonalityDeterministic(dailyData) {
  const dows = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dowTotals = {};
  const dowCounts = {};
  for (const d of dows) { dowTotals[d] = 0; dowCounts[d] = 0; }
  const monTotals = {};
  const monCounts = {};
  for (let i = 1; i <= 12; i++) { const k = String(i).padStart(2, '0'); monTotals[k] = 0; monCounts[k] = 0; }
  for (const row of dailyData) {
    const dt = new Date(row.date);
    if (isNaN(dt.getTime())) continue;
    const dow = dows[dt.getUTCDay()];
    dowTotals[dow] += row.pageviews || 0;
    dowCounts[dow] += 1;
    const mk = String(dt.getUTCMonth() + 1).padStart(2, '0');
    monTotals[mk] += row.pageviews || 0;
    monCounts[mk] += 1;
  }
  const avg_pageviews_by_day = {};
  for (const d of dows) avg_pageviews_by_day[d] = dowCounts[d] ? Math.round(dowTotals[d] / dowCounts[d]) : 0;
  const avg_pageviews_by_month = {};
  for (const k of Object.keys(monTotals)) avg_pageviews_by_month[k] = monCounts[k] ? Math.round(monTotals[k] / monCounts[k]) : 0;
  const ranked = Object.entries(avg_pageviews_by_month).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return {
    day_of_week_pattern: { avg_pageviews_by_day },
    monthly_pattern: { avg_pageviews_by_month },
    peak_season: ranked[0] ? `month ${ranked[0][0]}` : 'insufficient data',
    low_season: ranked.length ? `month ${ranked[ranked.length - 1][0]}` : 'insufficient data',
    insights: 'Day-of-week and monthly averages computed directly from daily Matomo data (last 90 days at daily granularity).',
    generated_without_llm: true,
  };
}

function buildDeterministicResults({ dailyData, weeklyData, articlesByMonth, referrerBreakdowns, keywordsByMonth, postMeta }) {
  return {
    traffic_summary:     buildTrafficSummaryDeterministic(dailyData, weeklyData),
    top_articles_18m:    buildTopArticlesDeterministic(articlesByMonth, postMeta),
    article_type_perf:   buildArticleTypePerformanceDeterministic(articlesByMonth, postMeta),
    topic_trends:        buildTopicTrendsDeterministic(articlesByMonth, postMeta),
    referrer_summary:    buildReferrerSummaryDeterministic(referrerBreakdowns),
    seasonality:         buildSeasonalityDeterministic(dailyData),
    search_keywords_18m: buildSearchKeywordsDeterministic(keywordsByMonth),
  };
}

// ---------------------------------------------------------------------------
// Phase 3: Sonnet Critic Pass
// ---------------------------------------------------------------------------

let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropicClient;
}

async function sonnetCritic(prompt, context) {
  const response = await getAnthropicClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    temperature: 0.4,
    system: withCachedSystem(`You are an editorial strategy expert for AltWire, a music and lifestyle publication.
You review draft analysis and refine it with deeper editorial judgment, content strategy thinking,
and industry context. Output only a JSON object — no markdown, no explanation outside the JSON.
The JSON must use the same schema as the draft provided. Improve the draft with sharper insights,
more specific recommendations, and clearer editorial framing.`),
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0].type === 'text' ? response.content[0].text : '';
}

async function criticTrafficSummary(minimaxOutput) {
  const prompt = `You are reviewing and refining an 18-month traffic analysis for AltWire.net.

Draft analysis:
${JSON.stringify(minimaxOutput)}

Refine the analysis. Improve the insights field with:
- Sharper editorial framing (what this means for a music/lifestyle publication)
- Specific recommendations for content calendar planning
- Industry context (comparative benchmarks if applicable)

Return the full JSON object with an improved "insights" field only. Keep all other fields unchanged.`;
  const raw = await sonnetCritic(prompt, minimaxOutput);
  return parseJsonResponse(raw);
}

async function criticTopicTrends(minimaxOutput) {
  const prompt = `You are reviewing and refining a topic trend analysis for AltWire.net.

Draft analysis:
${JSON.stringify(minimaxOutput)}

Refine the analysis:
- Sharpen the insights field with specific content opportunities (e.g. "Artists like X are underserved coverage area")
- Add editorial framing: which genres/articles have seasonal peaks that align with the data
- Flag any topics where traffic pattern suggests audience interest is undermonetized or undercovered

Return the full JSON object with improved insights and any new fields. Keep existing structure.`;
  const raw = await sonnetCritic(prompt, minimaxOutput);
  return parseJsonResponse(raw);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const force = process.argv.includes('--force');
  const explicitNoLlm = process.argv.includes('--no-llm');
  const hasMinimax = !!process.env.MINIMAX_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const noLlm = explicitNoLlm || (!hasMinimax && !hasAnthropic);

  log('Starting AltWire historical analytics seed', {
    mode: noLlm ? 'deterministic' : (hasMinimax ? 'minimax' : 'anthropic'),
  });

  const missing = validateConfig({ noLlm });
  if (missing.length > 0) {
    log(`FATAL: Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (!(await shouldRefresh(force))) {
    const last = await getLastRefreshed();
    log(`Skipping — last refresh was ${last?.toISOString()}. Use --force to override.`);
    if (pool) await pool.end().catch(() => {});
    process.exit(0);
  }

  const startDateStr = process.env.ALTWIRE_MATOMO_START_DATE || DEFAULT_START_DATE;
  const startDate = new Date(startDateStr);
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 3); // 3-day lag for Matomo data freshness

  log(`Fetching data from ${startDateStr} to ${formatDate(endDate)}`);

  // Fetch all data in parallel
  log('Fetching Matomo data...');
  const [trafficResult, articlesResult, referrerResult, keywordsResult, posts] = await Promise.allSettled([
    fetchDailySummaries(startDate, endDate),
    fetchTopArticlesByMonth(startDate, endDate),
    fetchReferrerBreakdowns(startDate, endDate),
    fetchSearchKeywords(startDate, endDate),
    fetchPostMetadata(200),
  ]);

  const { dailyData, weeklyData } = trafficResult.status === 'fulfilled' ? trafficResult.value : { dailyData: [], weeklyData: [] };
  const articlesByMonth = articlesResult.status === 'fulfilled' ? articlesResult.value : [];
  const referrerBreakdowns = referrerResult.status === 'fulfilled' ? referrerResult.value : [];
  const keywordsByMonth = keywordsResult.status === 'fulfilled' ? keywordsResult.value : [];
  const postMeta = posts.status === 'fulfilled' ? posts.value : [];

  log(`Data fetched: ${dailyData.length} daily rows, ${articlesByMonth.length} monthly article sets, ${referrerBreakdowns.length} referrer sets, ${keywordsByMonth.length} keyword sets`);

  let results;

  if (noLlm) {
    // Deterministic pass — compute the same schema directly from Matomo data.
    log('Running deterministic (no-LLM) analysis pass', {
      reason: explicitNoLlm ? '--no-llm flag' : 'no LLM API key configured',
    });
    results = buildDeterministicResults({ dailyData, weeklyData, articlesByMonth, referrerBreakdowns, keywordsByMonth, postMeta });
  } else {
    // Pass 1: LLM analysis (Minimax preferred, Anthropic fallback) — all 7 in parallel
    log('Running LLM analysis pass...', { engine: hasMinimax ? 'minimax' : 'anthropic' });
    const [
      llmTraffic,
      llmTopArticles,
      llmArticleType,
      llmTopicTrends,
      llmReferrer,
      llmSeasonality,
      llmSearchKeywords,
    ] = await Promise.allSettled([
      analyzeTrafficSummary(dailyData, weeklyData),
      analyzeTopArticles(articlesByMonth, postMeta),
      analyzeArticleTypePerformance(articlesByMonth, postMeta),
      analyzeTopicTrends(articlesByMonth, postMeta),
      analyzeReferrerSummary(referrerBreakdowns),
      analyzeSeasonality(dailyData),
      analyzeSearchKeywords(keywordsByMonth),
    ]);

    // Fall back to the deterministic builder for any individual analysis that failed,
    // so a single LLM error never leaves a memory key null.
    const deterministic = buildDeterministicResults({ dailyData, weeklyData, articlesByMonth, referrerBreakdowns, keywordsByMonth, postMeta });
    results = {
      traffic_summary:     llmTraffic.status === 'fulfilled' ? llmTraffic.value : deterministic.traffic_summary,
      top_articles_18m:    llmTopArticles.status === 'fulfilled' ? llmTopArticles.value : deterministic.top_articles_18m,
      article_type_perf:   llmArticleType.status === 'fulfilled' ? llmArticleType.value : deterministic.article_type_perf,
      topic_trends:        llmTopicTrends.status === 'fulfilled' ? llmTopicTrends.value : deterministic.topic_trends,
      referrer_summary:    llmReferrer.status === 'fulfilled' ? llmReferrer.value : deterministic.referrer_summary,
      seasonality:         llmSeasonality.status === 'fulfilled' ? llmSeasonality.value : deterministic.seasonality,
      search_keywords_18m: llmSearchKeywords.status === 'fulfilled' ? llmSearchKeywords.value : deterministic.search_keywords_18m,
    };

    // Pass 2: Sonnet critic on traffic_summary and topic_trends (Anthropic only)
    if (hasAnthropic) {
      log('Running Sonnet critic pass...');
      const [trafficCriticResult, topicTrendsCriticResult] = await Promise.allSettled([
        results.traffic_summary ? criticTrafficSummary(results.traffic_summary) : Promise.resolve(null),
        results.topic_trends ? criticTopicTrends(results.topic_trends) : Promise.resolve(null),
      ]);

      if (trafficCriticResult.status === 'fulfilled' && trafficCriticResult.value) {
        results.traffic_summary = trafficCriticResult.value;
        log('Sonnet critic refined traffic_summary');
      } else {
        log('Sonnet critic skipped traffic_summary', { status: trafficCriticResult.status, hasValue: !!trafficCriticResult.value, error: trafficCriticResult.status === 'rejected' ? trafficCriticResult.reason?.message : null });
      }
      if (topicTrendsCriticResult.status === 'fulfilled' && topicTrendsCriticResult.value) {
        results.topic_trends = topicTrendsCriticResult.value;
        log('Sonnet critic refined topic_trends');
      } else {
        log('Sonnet critic skipped topic_trends', { status: topicTrendsCriticResult.status, hasValue: !!topicTrendsCriticResult.value, error: topicTrendsCriticResult.status === 'rejected' ? topicTrendsCriticResult.reason?.message : null });
      }
    }
  }

  log('Minimally parsed results:', {
    traffic_summary:     results.traffic_summary ? 'populated' : 'null',
    top_articles_18m:     results.top_articles_18m ? 'populated' : 'null',
    article_type_perf:    results.article_type_perf ? 'populated' : 'null',
    topic_trends:        results.topic_trends ? 'populated' : 'null',
    referrer_summary:    results.referrer_summary ? 'populated' : 'null',
    search_keywords_18m:  results.search_keywords_18m ? 'populated' : 'null',
    seasonality:        results.seasonality ? 'populated' : 'null',
  });

  // Write all memory keys
  log('Writing memory keys to agent_memory...');
  const writePromises = [
    writeAgentMemory(AGENT, MEMORY_KEYS.TRAFFIC_SUMMARY,     JSON.stringify(results.traffic_summary)),
    writeAgentMemory(AGENT, MEMORY_KEYS.TOP_ARTICLES,        JSON.stringify(results.top_articles_18m)),
    writeAgentMemory(AGENT, MEMORY_KEYS.ARTICLE_TYPE_PERF,   JSON.stringify(results.article_type_perf)),
    writeAgentMemory(AGENT, MEMORY_KEYS.TOPIC_TRENDS,       JSON.stringify(results.topic_trends)),
    writeAgentMemory(AGENT, MEMORY_KEYS.REFERRER_SUMMARY,   JSON.stringify(results.referrer_summary)),
    writeAgentMemory(AGENT, MEMORY_KEYS.SEARCH_KEYWORDS,    JSON.stringify(results.search_keywords_18m)),
    writeAgentMemory(AGENT, MEMORY_KEYS.SEASONALITY,        JSON.stringify(results.seasonality)),
    writeAgentMemory(AGENT, MEMORY_KEYS.LAST_REFRESHED,     JSON.stringify({ timestamp: new Date().toISOString() })),
  ];

  await Promise.allSettled(writePromises);
  log('All memory keys written');

  log('Seed complete', {
    traffic_summary:     !!results.traffic_summary,
    top_articles_18m:   !!results.top_articles_18m,
    article_type_perf:  !!results.article_type_perf,
    topic_trends:       !!results.topic_trends,
    referrer_summary:   !!results.referrer_summary,
    search_keywords_18m: !!results.search_keywords_18m,
    seasonality:       !!results.seasonality,
  });

  await pool.end().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed-historical] FATAL:', err);
  process.exit(1);
});
