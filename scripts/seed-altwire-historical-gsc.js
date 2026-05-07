/**
 * scripts/seed-altwire-historical-gsc.js
 *
 * Pulls the maximum available Google Search Console history for AltWire
 * (~16 months — GSC's hard retention limit) and writes summarized,
 * LLM-analyzed memory keys into agent_memory under the `hal` agent.
 *
 * Memory keys written:
 *   hal:altwire:gsc:summary_16m            — overall trends, totals, position drift
 *   hal:altwire:gsc:top_queries_16m        — top organic search queries
 *   hal:altwire:gsc:top_pages_16m          — top organic landing pages
 *   hal:altwire:gsc:opportunities_16m      — long-running opportunity-zone queries
 *   hal:altwire:gsc:news_performance_16m   — Google News performance summary
 *   hal:altwire:gsc:monthly_breakdown      — month-by-month rollup (raw, no LLM)
 *   hal:altwire:gsc:last_refreshed         — { timestamp }
 *
 * Idempotent. Safe to re-run with --force.
 *
 * Usage:
 *   node scripts/seed-altwire-historical-gsc.js          # skip if < 30 days old
 *   node scripts/seed-altwire-historical-gsc.js --force  # full re-fetch
 *   node scripts/seed-altwire-historical-gsc.js --no-llm # raw rollups only
 *
 * Environment:
 *   ALTWIRE_DATABASE_URL                — Postgres
 *   ALTWIRE_GSC_SERVICE_ACCOUNT_JSON    — GSC service account
 *   ALTWIRE_GSC_SITE_URL                — GSC site URL
 *   ANTHROPIC_API_KEY                   — required unless --no-llm
 */

import Anthropic from '@anthropic-ai/sdk';
import pool, { writeAgentMemory, readAgentMemory } from '../lib/altus-db.js';
import {
  getSearchPerformance,
  getNewsSearchPerformance,
  getOpportunityZoneQueries,
} from '../handlers/altwire-gsc-client.js';

const AGENT = 'hal';
const KEYS = {
  SUMMARY:           'hal:altwire:gsc:summary_16m',
  TOP_QUERIES:       'hal:altwire:gsc:top_queries_16m',
  TOP_PAGES:         'hal:altwire:gsc:top_pages_16m',
  OPPORTUNITIES:     'hal:altwire:gsc:opportunities_16m',
  NEWS_PERFORMANCE:  'hal:altwire:gsc:news_performance_16m',
  MONTHLY_BREAKDOWN: 'hal:altwire:gsc:monthly_breakdown',
  LAST_REFRESHED:    'hal:altwire:gsc:last_refreshed',
};
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const GSC_LAG_DAYS = 3;
const GSC_HISTORY_DAYS = 480; // ~16 months

const log = (msg, data = {}) => console.log(`[seed-gsc] ${msg}`, JSON.stringify(data));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }

function isoDateOffset(daysBack) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysBack);
  return fmtDate(d);
}

function* monthBuckets(startDate, endDate) {
  const cur = new Date(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1);
  const end = new Date(endDate);
  while (cur <= end) {
    const monthStart = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
    const clampedStart = monthStart < startDate ? startDate : monthStart;
    const clampedEnd = monthEnd > endDate ? endDate : monthEnd;
    yield { start: fmtDate(clampedStart), end: fmtDate(clampedEnd), label: `${cur.getUTCFullYear()}-${pad(cur.getUTCMonth() + 1)}` };
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
}

async function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function validateConfig(useLlm) {
  const missing = [];
  if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) missing.push('ALTWIRE_DATABASE_URL');
  if (!process.env.ALTWIRE_GSC_SERVICE_ACCOUNT_JSON) missing.push('ALTWIRE_GSC_SERVICE_ACCOUNT_JSON');
  if (!process.env.ALTWIRE_GSC_SITE_URL) missing.push('ALTWIRE_GSC_SITE_URL');
  if (useLlm && !process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  return missing;
}

async function shouldRefresh(force) {
  if (force) return true;
  const r = await readAgentMemory(AGENT, KEYS.LAST_REFRESHED);
  if (!r.success) return true;
  try {
    const last = new Date(JSON.parse(r.value).timestamp);
    // Missing/invalid timestamp → treat as unknown refresh state and refresh,
    // matching the behavior of !r.success and the catch block below.
    if (Number.isNaN(last.getTime())) return true;
    return Date.now() - last.getTime() > THIRTY_DAYS_MS;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — Fetch (16 months total + monthly slices)
// ---------------------------------------------------------------------------

async function fetchAggregate(startDate, endDate) {
  log('Fetching 16-month aggregates');

  const [topQueries, topPages, oppZone, news] = await Promise.all([
    getSearchPerformance(startDate, endDate, { rowLimit: 500, dimensions: ['query'] }),
    getSearchPerformance(startDate, endDate, { rowLimit: 500, dimensions: ['page'] }),
    getOpportunityZoneQueries(startDate, endDate),
    getNewsSearchPerformance(startDate, endDate, { rowLimit: 200, dimensions: ['query'] }),
  ]);

  return { topQueries, topPages, oppZone, news };
}

async function fetchMonthlyBreakdown(startDate, endDate) {
  const buckets = [...monthBuckets(startDate, endDate)];
  log(`Fetching monthly breakdown across ${buckets.length} months`);
  const monthly = [];
  for (const b of buckets) {
    const r = await getSearchPerformance(b.start, b.end, { dimensions: [] });
    if (r.error) {
      monthly.push({ month: b.label, error: r.error });
    } else {
      const totals = (r.rows ?? []).reduce(
        (acc, row) => ({
          clicks: acc.clicks + (row.clicks ?? 0),
          impressions: acc.impressions + (row.impressions ?? 0),
        }),
        { clicks: 0, impressions: 0 }
      );
      monthly.push({
        month: b.label,
        start: b.start,
        end: b.end,
        clicks: totals.clicks,
        impressions: totals.impressions,
        ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : 0,
      });
    }
    await delay(250); // gentle rate limit
  }
  return monthly;
}

// ---------------------------------------------------------------------------
// Phase 2 — LLM analysis (Sonnet)
// ---------------------------------------------------------------------------

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

async function analyze(prompt, schemaHint) {
  if (!anthropic) return null;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      temperature: 0.3,
      system: `You are an editorial SEO analyst for AltWire (music & lifestyle publication).
You analyze 16 months of Google Search Console data and produce concise, actionable summaries.
Output a single JSON object only — no markdown, no explanation outside the JSON.
Be specific: cite actual queries, pages, impressions, positions, and trends.`,
      messages: [{ role: 'user', content: `${prompt}\n\nReturn only a JSON object matching: ${schemaHint}` }],
    });
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const trimmed = text.trim();
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first === -1) return null;
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch (err) {
    log('LLM analysis failed', { error: err.message });
    return null;
  }
}

async function analyzeSummary(monthly, topQueries, topPages) {
  const prompt = `Analyze 16 months of AltWire GSC performance.

Monthly clicks/impressions breakdown:
${JSON.stringify(monthly)}

Top 30 queries by impressions:
${JSON.stringify((topQueries.rows ?? []).slice(0, 30))}

Top 30 pages by impressions:
${JSON.stringify((topPages.rows ?? []).slice(0, 30))}`;
  return analyze(prompt, `{
  "total_clicks": number,
  "total_impressions": number,
  "avg_ctr": number,
  "avg_position": number,
  "peak_month": "YYYY-MM",
  "peak_month_clicks": number,
  "trend_direction": "rising" | "stable" | "declining",
  "trend_evidence": string,
  "insights": string (3-4 sentences on organic visibility, brand vs non-brand, position drift, content categories that perform)
}`);
}

async function analyzeTopQueries(topQueries) {
  const rows = (topQueries.rows ?? []).slice(0, 50);
  const prompt = `Top 50 AltWire queries by impressions over 16 months:\n${JSON.stringify(rows)}`;
  return analyze(prompt, `{
  "top_30": [{"query": string, "clicks": number, "impressions": number, "ctr": number, "position": number}, ...],
  "brand_queries": [{"query": string, "impressions": number}, ...] (queries containing "altwire"),
  "best_ctr_queries": [{"query": string, "ctr": number, "impressions": number}, ...] (top 5 by CTR among top 50),
  "insights": string
}`);
}

async function analyzeTopPages(topPages) {
  const rows = (topPages.rows ?? []).slice(0, 50);
  const prompt = `Top 50 AltWire landing pages by GSC impressions over 16 months:\n${JSON.stringify(rows)}`;
  return analyze(prompt, `{
  "top_20": [{"url": string, "clicks": number, "impressions": number, "ctr": number, "position": number}, ...],
  "evergreen_pages": [{"url": string, "rationale": string}, ...] (top 5 still pulling impressions),
  "insights": string
}`);
}

async function analyzeOpportunities(oppZone) {
  const rows = oppZone.rows ?? [];
  const prompt = `AltWire GSC opportunity-zone (position 5–30) queries over 16 months:\n${JSON.stringify(rows.slice(0, 100))}`;
  return analyze(prompt, `{
  "high_value_opportunities": [{"query": string, "page": string, "impressions": number, "position": number, "rationale": string}, ...] (top 15),
  "themes": [string, ...] (recurring topics across opportunities),
  "insights": string
}`);
}

async function analyzeNews(news) {
  const rows = news.rows ?? [];
  if (!rows.length) {
    return { available: false, note: news.note ?? 'No GSC News data — site may not be in News index yet.' };
  }
  const prompt = `AltWire GSC News search type performance over 16 months:\n${JSON.stringify(rows.slice(0, 50))}`;
  const result = await analyze(prompt, `{
  "top_news_queries": [{"query": string, "clicks": number, "impressions": number, "position": number}, ...],
  "insights": string
}`);
  // analyze() returns null on LLM failure or JSON parse error. Fall back to
  // raw rows so downstream consumers don't see `{ available: true }` with no
  // actual data — same shape as the --no-llm path.
  if (!result) {
    return {
      available: true,
      llm_summary_unavailable: true,
      top_news_queries: rows.slice(0, 20),
    };
  }
  return { available: true, ...result };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = new Set(process.argv.slice(2));
  const force = args.has('--force');
  const useLlm = !args.has('--no-llm');

  const missing = validateConfig(useLlm);
  if (missing.length) {
    console.error(`[seed-gsc] FATAL: missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (!(await shouldRefresh(force))) {
    log('Skipping — last refresh was within 30 days. Use --force to override.');
    await pool.end().catch(() => {});
    return;
  }

  const endDateStr = isoDateOffset(GSC_LAG_DAYS);
  const startDateStr = isoDateOffset(GSC_HISTORY_DAYS);
  const startDate = new Date(startDateStr);
  const endDate = new Date(endDateStr);

  log(`Fetching GSC data from ${startDateStr} to ${endDateStr}`);

  const aggregate = await fetchAggregate(startDateStr, endDateStr);

  if (aggregate.topQueries.error) {
    console.error(`[seed-gsc] FATAL: GSC aggregate fetch failed: ${aggregate.topQueries.error}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  const monthly = await fetchMonthlyBreakdown(startDate, endDate);

  log('Aggregate fetched', {
    queries: (aggregate.topQueries.rows ?? []).length,
    pages: (aggregate.topPages.rows ?? []).length,
    opportunity_rows: (aggregate.oppZone.rows ?? []).length,
    news_rows: (aggregate.news.rows ?? []).length,
    monthly_buckets: monthly.length,
  });

  let summary = null, topQueries = null, topPages = null, opps = null, news = null;
  if (useLlm) {
    log('Running LLM analysis pass');
    [summary, topQueries, topPages, opps, news] = await Promise.all([
      analyzeSummary(monthly, aggregate.topQueries, aggregate.topPages),
      analyzeTopQueries(aggregate.topQueries),
      analyzeTopPages(aggregate.topPages),
      analyzeOpportunities(aggregate.oppZone),
      analyzeNews(aggregate.news),
    ]);
  } else {
    summary = {
      total_clicks: monthly.reduce((s, m) => s + (m.clicks ?? 0), 0),
      total_impressions: monthly.reduce((s, m) => s + (m.impressions ?? 0), 0),
      raw: true,
    };
    topQueries = { top_30: (aggregate.topQueries.rows ?? []).slice(0, 30) };
    topPages = { top_20: (aggregate.topPages.rows ?? []).slice(0, 20) };
    opps = { high_value_opportunities: (aggregate.oppZone.rows ?? []).slice(0, 15) };
    news = { available: !!aggregate.news.rows?.length, top_news_queries: (aggregate.news.rows ?? []).slice(0, 20) };
  }

  log('Writing memory keys');
  const writes = [
    [KEYS.SUMMARY,           JSON.stringify(summary ?? {})],
    [KEYS.TOP_QUERIES,       JSON.stringify(topQueries ?? {})],
    [KEYS.TOP_PAGES,         JSON.stringify(topPages ?? {})],
    [KEYS.OPPORTUNITIES,     JSON.stringify(opps ?? {})],
    [KEYS.NEWS_PERFORMANCE,  JSON.stringify(news ?? {})],
    [KEYS.MONTHLY_BREAKDOWN, JSON.stringify({ months: monthly })],
  ];
  const results = await Promise.allSettled(
    writes.map(([key, value]) => writeAgentMemory(AGENT, key, value))
  );
  const failures = results
    .map((r, i) => ({ key: writes[i][0], status: r.status, reason: r.reason?.message ?? r.value?.error ?? null }))
    .filter((r) => r.status === 'rejected' || r.reason);

  if (failures.length > 0) {
    log('Memory write failures — NOT updating LAST_REFRESHED so the next run will retry', { failures });
    await pool.end().catch(() => {});
    process.exit(1);
  }

  // Only mark LAST_REFRESHED once all data keys have been written successfully —
  // otherwise a partial-write would skip retries for 30 days (see shouldRefresh).
  await writeAgentMemory(
    AGENT,
    KEYS.LAST_REFRESHED,
    JSON.stringify({ timestamp: new Date().toISOString(), startDate: startDateStr, endDate: endDateStr })
  );

  log('Seed complete', {
    summary: !!summary, top_queries: !!topQueries, top_pages: !!topPages,
    opportunities: !!opps, news: !!news, months: monthly.length,
  });

  await pool.end().catch(() => {});
}

main().catch((err) => {
  console.error('[seed-gsc] FATAL:', err);
  process.exit(1);
});
