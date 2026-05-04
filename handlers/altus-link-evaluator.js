/**
 * handlers/altus-link-evaluator.js
 *
 * Pre-publication content evaluation tool for AltWire.
 * Given a URL (and optional admin description), Hal fetches the content,
 * cross-references it against AltWire's editorial context, historical analytics,
 * and archive coverage, then returns a plain-language fit assessment with a
 * suggested angle if it's a good fit.
 *
 * Used by: evaluate_link_fitness MCP tool (altwire-altus/index.js)
 */

import { logger } from '../logger.js';
import { searchAltwireArchive } from './altus-search.js';
import { loadEditorialContext } from '../lib/editorial-helpers.js';
import { emitToolEvent } from '../lib/safe-tool-handler.js';
import pool from '../lib/altus-db.js';

const ANALYTICS_KEYS = {
  traffic_summary:      'hal:altwire:analytics:traffic_summary',
  top_articles_18m:    'hal:altwire:analytics:top_articles_18m',
  article_type_perf:   'hal:altwire:analytics:article_type_performance',
  topic_trends:        'hal:altwire:analytics:topic_trends',
  seasonality:         'hal:altwire:analytics:seasonality',
};

async function readAgentMemoryDirect(agent, key) {
  const { rows } = await pool.query(
    'SELECT value FROM agent_memory WHERE agent = $1 AND key = $2 AND deleted_at IS NULL',
    [agent, key]
  );
  return rows[0]?.value ?? null;
}

async function loadAnalyticsKeys() {
  const { rows } = await pool.query(
    `SELECT key, value FROM agent_memory
     WHERE agent = 'hal' AND key LIKE 'hal:altwire:analytics:%' AND deleted_at IS NULL`
  );
  const result = {};
  for (const row of rows) {
    try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
  }
  return result;
}

function extractMeta(text, type) {
  const patterns = {
    title: [
      /<title[^>]*>([^<]+)<\/title>/i,
      /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
      /<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i,
    ],
    description: [
      /<meta[^>]+name="description"[^>]+content="([^"]+)"/i,
      /<meta[^>]+content="([^"]+)"[^>]+name="description"/i,
      /<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i,
    ],
    'og:image': [
      /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
      /<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i,
    ],
  };
  const regexes = patterns[type] || [];
  for (const r of regexes) {
    const m = text.match(r);
    if (m && m[1]) return decodeHTMLEntities(m[1].trim());
  }
  return null;
}

function extractBodyText(text) {
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function fetchPageContent(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AltWireBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) return { error: `HTTP ${res.status}` };

    const html = await res.text();
    const title = extractMeta(html, 'title');
    const description = extractMeta(html, 'description');
    const ogImage = extractMeta(html, 'og:image');
    const bodyText = extractBodyText(html);

    return { title, description, bodyText: bodyText.slice(0, 3000), ogImage };
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'fetch_timeout' };
    return { error: err.message };
  }
}

/**
 * Evaluate the editorial fitness of a link for AltWire.
 *
 * @param {{ url: string, description?: string }} params
 * @returns {Promise<object>}
 */
export async function evaluateLinkFitness({ url, description }) {
  const step = (msg) => emitToolEvent('tool_start', 'evaluate_link_fitness:step', msg);

  try {
    step('Fetching page content...');
    const page = await fetchPageContent(url);
    if (page.error) {
      emitToolEvent('tool_done', 'evaluate_link_fitness', 'Fetch failed');
      return {
        url,
        fetch_error: page.error,
        fit: null,
        reasoning: null,
        suggested_angle: null,
        steps_completed: ['fetch_content'],
      };
    }

    step('Loading AltWire editorial context...');
    const [analyticsResult, editorialResult, archiveResult] = await Promise.allSettled([
      loadAnalyticsKeys(),
      loadEditorialContext(readAgentMemoryDirect),
      searchAltwireArchive({ query: page.title || url, limit: 5, content_type: 'all' }),
    ]);

    const analytics = analyticsResult?.status === 'fulfilled' ? analyticsResult.value : {};
    const editorial = editorialResult?.status === 'fulfilled' ? editorialResult.value : null;
    const archive = archiveResult?.status === 'fulfilled' ? archiveResult.value : { results: [] };

    step('Cross-referencing with AltWire data...');

    const ts = analytics[ANALYTICS_KEYS.traffic_summary];
    const ta = analytics[ANALYTICS_KEYS.top_articles_18m];
    const tp = analytics[ANALYTICS_KEYS.article_type_perf];
    const tt = analytics[ANALYTICS_KEYS.topic_trends];
    const ss = analytics[ANALYTICS_KEYS.seasonality];

    const lines = [];
    lines.push(`SUBJECT PAGE TITLE: ${page.title || '(no title fetched)'}`);
    lines.push(`SUBJECT PAGE DESCRIPTION: ${page.description || '(none)'}`);
    if (description) lines.push(`ADMIN PROVIDED CONTEXT: ${description}`);
    lines.push('');

    if (ts) {
      lines.push(`18-MONTH TRAFFIC SUMMARY:`);
      lines.push(`  Total pageviews: ${ts.total_pageviews?.toLocaleString() ?? 'N/A'}`);
      lines.push(`  Peak month: ${ts.peak_month ?? 'N/A'} (${ts.peak_month_pageviews?.toLocaleString() ?? 'N/A'} pv)`);
      lines.push(`  Traffic trend: ${ts.trend_direction ?? 'N/A'}`);
      lines.push(`  Avg monthly pageviews: ${ts.avg_monthly_pageviews?.toLocaleString() ?? 'N/A'}`);
    }
    if (ta?.all_time_top_10?.length) {
      const top5 = ta.all_time_top_10.slice(0, 5);
      lines.push(`ALL-TIME TOP 5 ARTICLES BY PAGEVIEWS: ${top5.map((a, i) => `${i + 1}. "${a.title}" — ${a.total_pageviews?.toLocaleString() ?? 'N/A'} pv`).join(' | ')}`);
    }
    if (tp?.type_breakdown) {
      lines.push(`ARTICLE TYPE PERFORMANCE (18m pageviews): ${JSON.stringify(tp.type_breakdown)}`);
    }
    if (tt?.rising_topics?.length) {
      lines.push(`RISING TOPICS (editorial momentum): ${tt.rising_topics.map((t) => `${t.topic} (+${t.trend_pct}%)`).join(', ')}`);
    }
    if (tt?.declining_topics?.length) {
      lines.push(`DECLINING TOPICS: ${tt.declining_topics.map((t) => t.topic).join(', ')}`);
    }
    if (editorial?.subjects) {
      lines.push(`ALTWIRE EDITORIAL GENRES: ${(editorial.subjects.top_genres ?? []).join(', ')}`);
      lines.push(`ALTWIRE EDITORIAL ANGLES: ${(editorial.subjects.common_angles ?? []).join(', ')}`);
    }
    if (ss?.peak_season || ss?.low_season) {
      lines.push(`SEASONAL PATTERN: Peak=${ss.peak_season ?? 'N/A'} | Low=${ss.low_season ?? 'N/A'}`);
    }
    if (archive.results?.length) {
      lines.push(`ALTWIRE ARCHIVE COVERAGE (top 3 by relevance): ${archive.results.slice(0, 3).map((r) => `"${r.title}" (similarity ${r.weighted_score?.toFixed(2) ?? '?'})`).join(' | ')}`);
    } else {
      lines.push(`ALTWIRE ARCHIVE COVERAGE: No existing coverage found for this topic — potential gap`);
    }
    if (page.bodyText) {
      lines.push(`\nPAGE CONTENT PREVIEW (first 1500 chars):\n${page.bodyText.slice(0, 1500)}`);
    }

    step('Running editorial fit analysis...');
    const fitResult = await analyzeFitWithLLM(lines.join('\n'));

    emitToolEvent('tool_done', 'evaluate_link_fitness', `Fit: ${fitResult.fit}`);

    return {
      url,
      page_title: page.title || null,
      page_description: page.description || null,
      fetch_error: null,
      fit: fitResult.fit,
      reasoning: fitResult.reasoning,
      suggested_angle: fitResult.suggested_angle,
      evidence: fitResult.evidence || null,
      steps_completed: ['fetch_content', 'load_context', 'cross_reference', 'analyze_fit'],
    };
  } catch (err) {
    logger.error('evaluateLinkFitness failed', { error: err.message, url });
    emitToolEvent('tool_done', 'evaluate_link_fitness', 'Error');
    return {
      url,
      fetch_error: null,
      fit: null,
      reasoning: `Evaluation failed unexpectedly: ${err.message}`,
      suggested_angle: null,
      steps_completed: ['fetch_content'],
    };
  }
}

async function analyzeFitWithLLM(contextDump) {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey: process.env.MINIMAX_API_KEY,
    baseURL: 'https://api.minimax.chat/v1',
  });

  const SYSTEM = `You are an editorial strategist for AltWire, an independent music and lifestyle publication. You evaluate whether external content or stories are a good fit for AltWire's editorial identity.

Output a JSON object with exactly this structure — no markdown, no explanation outside the JSON:
{
  "fit": "excellent" | "decent" | "okay" | "questionable" | "poor",
  "reasoning": "2-4 sentences explaining why, citing specific evidence from the context provided",
  "suggested_angle": "if fit is decent or excellent: one specific AltWire angle in 1-2 sentences. Otherwise null.",
  "evidence": {
    "matches_trending": boolean,
    "matches_editorial_genre": boolean,
    "has_coverage_gap": boolean,
    "seasonal_fit": boolean,
    "social_virality_signal": boolean
  }
}

Fit levels:
- "excellent": strongly aligned with AltWire's genre/topic mix, rising topic, clear coverage gap, strong angle potential
- "decent": generally in-scope, some alignment, minor gaps or competition, worth considering
- "okay": loosely in-scope, unclear angle, or significant gaps
- "questionable": mostly out of scope — wrong genre, topic already well-covered, no clear angle
- "poor": clearly not a fit — wrong publication type, no editorial angle

Cite specific titles, numbers, or genres from the context in your reasoning. Be direct and specific.`;

  const response = await client.chat.completions.create({
    model: 'MiniMax-Text-01',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: contextDump },
    ],
    temperature: 0.3,
    max_tokens: 800,
  });

  const raw = response.choices[0]?.message?.content ?? '';
  try {
    const trimmed = raw.trim();
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first === -1 || last === -1) throw new Error('No JSON object found');
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    return {
      fit: 'okay',
      reasoning: 'LLM returned malformed response — defaulting to "okay". Review manually.',
      suggested_angle: null,
      evidence: null,
    };
  }
}