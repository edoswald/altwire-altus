import { getAltwireMorningDigest } from './altus-digest.js';
import { buildAnalyticsSnapshot } from './altus-digest-analytics.js';
import { listStoryOpportunityQueue } from './altus-opportunity-queue.js';
import pool from '../lib/altus-db.js';
import { generate } from '../lib/writer-client.js';
import { markdownToHtml } from '../lib/markdown.js';
import { readAgentMemory, writeAgentMemory } from '../lib/altus-db.js';
import { sendEmail } from '../lib/ses-client.js';
import { logger } from '../logger.js';
import { withCachedSystem } from '../lib/anthropic-cache.js';
import { extractText, isRefusal, submitBatch, collectBatch, logBatchUsage } from '../batch-client.js';
import { MODEL_OPUS, resolveModel } from '../lib/model-ids.js';

const WEEKLY_MODEL = resolveModel(process.env.ALTUS_WEEKLY_MODEL, MODEL_OPUS);

function getIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

export async function sendAltusWeeklyBrief() {
  if (!process.env.DEREK_EMAIL) {
    logger.warn('[altus-weekly-brief] DEREK_EMAIL not set — skipping brief submit');
    return { success: false, skipped: true, reason: 'missing_derek_email' };
  }

  try {
    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    const [
      morningDigest,
      monthAnalytics,
      storyQueue,
      trafficSummary,
      topArticles,
      siteSearchKw,
      editorialContext,
      priorBrief,
    ] = await Promise.allSettled([
      getAltwireMorningDigest(),
      buildAnalyticsSnapshot({ days: 28 }),
      listStoryOpportunityQueue({ status: 'active', limit: 10 }),
      readAgentMemory('hal', 'hal:altwire:traffic_summary'),
      readAgentMemory('hal', 'hal:altwire:top_articles'),
      readAgentMemory('hal', 'hal:altwire:site_search_keywords'),
      readAgentMemory('hal', 'hal:altwire:editorial_context'),
      readAgentMemory('altus', 'altus:weekly_brief:latest'),
    ]);

    const newsAlerts = await Promise.allSettled([
      readAgentMemory('altus', `altus:news_alert:${today}`),
      readAgentMemory('altus', `altus:news_alert:${yesterday}`),
    ]);

    const getValue = (result) => result.status === 'fulfilled' && result.value?.success ? result.value.value : null;
    const getNewsAlert = (result) => result.status === 'fulfilled' && result.value?.success ? result.value.value : null;

    const trafficSummaryVal = getValue(trafficSummary);
    const topArticlesVal = getValue(topArticles);
    const siteSearchKwVal = getValue(siteSearchKw);
    const editorialContextVal = getValue(editorialContext);
    const priorBriefVal = getValue(priorBrief);
    const morningDigestVal = morningDigest.status === 'fulfilled' ? morningDigest.value : null;
    const newsAlertToday = getNewsAlert(newsAlerts[0]);
    const newsAlertYesterday = getNewsAlert(newsAlerts[1]);
    const monthAnalyticsVal = monthAnalytics.status === 'fulfilled' ? monthAnalytics.value : null;
    const storyOppsVal = storyQueue.status === 'fulfilled' && storyQueue.value?.success
      ? JSON.stringify(storyQueue.value.opportunities)
      : null;

    const newsAlertsText = [newsAlertToday, newsAlertYesterday]
      .filter(Boolean)
      .map(n => {
        try {
          const parsed = JSON.parse(n);
          return parsed.headline || parsed.alert || JSON.stringify(parsed);
        } catch {
          return n;
        }
      })
      .join('\n');

    const prompt = buildBriefPrompt({
      trafficSummary: trafficSummaryVal,
      topArticles: topArticlesVal,
      siteSearchKw: siteSearchKwVal,
      newsAlerts: newsAlertsText,
      storyOpportunities: storyOppsVal,
      editorialContext: editorialContextVal,
      priorBrief: priorBriefVal,
      morningDigest: morningDigestVal,
      monthAnalytics: monthAnalyticsVal,
    });

    const weekLabel = `Week of ${formatWeekRange(now)}`;
    const batchId = await submitBatch([{
      custom_id: `altus-weekly-brief-${getIsoWeek(now)}`,
      params: {
        model: WEEKLY_MODEL,
        // Thinking counts toward max_tokens at high effort — leave headroom.
        max_tokens: 16000,
        output_config: { effort: 'high' },
        // Cached so repeat weekly submissions (and the shared identity prefix)
        // are billed at the cache-read rate.
        system: withCachedSystem(prompt.system),
        messages: [{ role: 'user', content: prompt.prompt }],
      },
    }]);

    await pool.query(
      `INSERT INTO altus_weekly_brief_batches (batch_id, week_label, prompt_json, status)
       VALUES ($1, $2, $3::jsonb, 'pending')`,
      [batchId, weekLabel, JSON.stringify(prompt)],
    );

    logger.info('[altus-weekly-brief] Submitted weekly brief batch', { batch_id: batchId, weekLabel, model: WEEKLY_MODEL });
    return { success: true, batch_id: batchId, week_label: weekLabel };
  } catch (err) {
    logger.error('[altus-weekly-brief] Failed to submit weekly brief batch', { error: err.message });
    return { success: false, error: err.message };
  }
}

function buildBriefPrompt({ trafficSummary, topArticles, siteSearchKw, newsAlerts, storyOpportunities, editorialContext, priorBrief, morningDigest, monthAnalytics }) {
  const trafficParsed = trafficSummary ? safeParseJson(trafficSummary) : null;
  const topArticlesParsed = topArticles ? safeParseJson(topArticles) : null;
  const siteSearchParsed = siteSearchKw ? safeParseJson(siteSearchKw) : null;
  const storyOppsParsed = storyOpportunities ? safeParseJson(storyOpportunities) : null;
  const editorialCtxParsed = editorialContext ? safeParseJson(editorialContext) : null;
  const priorParsed = priorBrief ? safeParseJson(priorBrief) : null;
  const morningDigestParsed = morningDigest || null;

  const systemPrompt = 'You are Altus, the AI operations layer for AltWire — an independent music publication covering indie rock, alternative, and emerging artists.';

  const prompt = `You are writing the weekly analytics brief email to Derek, AltWire's editor-in-chief.

Derek's preferences:
- Lead with the headline number (e.g. "Traffic was up 12% this week")
- Concise — he'll ask for more detail if he wants it
- Editorial focus — indie rock, alternative, emerging artists
- Article-level analytics, not site-wide averages
- No long preambles, no sign-off

Use only numbers present in the context below. Never invent figures. If a source is missing, say so in one short clause and move on.

Write the brief in these sections:

## The Week
2-3 sentences. Lead with week-over-week traffic (THIS WEEK ANALYTICS.traffic) and search clicks (search.totals), and put them against the 28-day trend (LAST 28 DAYS ANALYTICS).

## What Moved
The 2-3 most important risers or fallers across pages and search queries, each with its number and change. Say what it means editorially (a story catching on, a seasonal drop, a ranking slip).

## Search & Discovery
New queries in positions 5-30, Google News pickup, and the biggest search-demand gaps (queries with demand but weak archive coverage). Name the specific queries.

## Recent Articles
How the last two weeks' articles are performing (recent_articles): which are pulling views or search clicks, and which have stalled.

## One Recommendation
The single highest-leverage editorial action for this week: refresh, follow-up, or new piece. Name the article, query, or opportunity, cite the number behind it, and say why now.

---

Context:
THIS WEEK ANALYTICS (last 7 days vs prior 7; from the morning digest): ${morningDigestParsed?.analytics ? JSON.stringify(morningDigestParsed.analytics, null, 2) : 'No data available'}
LAST 28 DAYS ANALYTICS (vs prior 28): ${monthAnalytics ? JSON.stringify(monthAnalytics, null, 2) : 'No data available'}
EDITORIAL SYNTHESIS: ${morningDigestParsed?.editorial_synthesis ? JSON.stringify(morningDigestParsed.editorial_synthesis, null, 2) : 'No data available'}
18-MONTH HISTORICAL CONTEXT: ${morningDigestParsed?.historical ? JSON.stringify(morningDigestParsed.historical, null, 2) : 'No data available'}
TRAFFIC SUMMARY: ${trafficParsed ? JSON.stringify(trafficParsed, null, 2) : 'No data available'}
TOP ARTICLES: ${topArticlesParsed ? JSON.stringify(topArticlesParsed, null, 2) : 'No data available'}
SITE SEARCH KEYWORDS: ${siteSearchParsed ? JSON.stringify(siteSearchParsed, null, 2) : 'No data available'}
NEWS ALERTS THIS WEEK: ${newsAlerts || 'None'}
STORY OPPORTUNITY QUEUE: ${storyOppsParsed ? JSON.stringify(storyOppsParsed, null, 2) : 'No data available'}
EDITORIAL CONTEXT: ${editorialCtxParsed ? JSON.stringify(editorialCtxParsed, null, 2) : 'No data available'}
PRIOR BRIEF (for continuity; don't repeat last week's recommendation unless it still stands): ${priorParsed ? JSON.stringify(priorParsed, null, 2) : 'No prior brief'}

Write only the brief. No preamble, no "Here is your brief:", no sign-off beyond "— Altus".
Target length: 400–600 words.`;

  return { system: systemPrompt, prompt };
}

async function generateBriefFallback(promptJson) {
  return generate({
    toolName: 'altus_weekly_brief_fallback',
    system: promptJson.system,
    prompt: promptJson.prompt,
    maxTokens: 2000,
  });
}

export async function deliverAltusWeeklyBrief(briefText, weekLabel) {
  if (!briefText || !briefText.trim()) {
    logger.error('[altus-weekly-brief] Empty brief text — not sending');
    return { success: false, error: 'empty_brief' };
  }

  const briefHtml = markdownToHtml(briefText);
  const subject = `AltWire Weekly Brief — ${weekLabel}`;
  const html = buildWeeklyBriefHtml(weekLabel, briefHtml);

  try {
    await sendEmail({
      to: process.env.DEREK_EMAIL,
      subject,
      html,
      text: briefText,
    });

    logger.info(`[altus-weekly-brief] Sent weekly brief to Derek — ${weekLabel}`);
    await persistAltusWeeklyBrief(briefText, weekLabel);
    return { success: true };
  } catch (err) {
    logger.error('[altus-weekly-brief] Failed to deliver weekly brief', { error: err.message });
    return { success: false, error: err.message };
  }
}

function parsePromptJson(value) {
  if (!value) return null;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

export async function collectAltusWeeklyBriefBatches() {
  const summary = { completed: [], failed: [] };
  const { rows } = await pool.query(
    `SELECT id, batch_id, week_label, prompt_json
       FROM altus_weekly_brief_batches
      WHERE status = 'pending'
      ORDER BY submitted_at ASC`,
  );

  for (const row of rows) {
    let results;
    try {
      results = await collectBatch(row.batch_id);
    } catch (err) {
      logger.error('[altus-weekly-brief] collectBatch failed', { batch_id: row.batch_id, error: err.message });
      continue;
    }

    if (results === null) continue;

    const first = results[0];
    const promptJson = parsePromptJson(row.prompt_json);
    let briefText = extractText(first);

    if (isRefusal(first) || !briefText) {
      logger.warn('[altus-weekly-brief] Batch returned refusal or empty content, using fallback', {
        batch_id: row.batch_id,
        refusal: isRefusal(first),
      });
      try {
        briefText = await generateBriefFallback(promptJson);
      } catch (err) {
        await pool.query(
          `UPDATE altus_weekly_brief_batches
              SET status = 'failed', error_message = $2
            WHERE id = $1`,
          [row.id, `Fallback compose failed: ${err.message}`],
        );
        await logBatchUsage(row.batch_id, results, 'altus_weekly_brief');
        summary.failed.push({ week_label: row.week_label, error: err.message });
        continue;
      }
    }

    const delivered = await deliverAltusWeeklyBrief(briefText, row.week_label);
    await logBatchUsage(row.batch_id, results, 'altus_weekly_brief');

    if (!delivered.success) {
      await pool.query(
        `UPDATE altus_weekly_brief_batches
            SET status = 'failed', error_message = $2
          WHERE id = $1`,
        [row.id, delivered.error ?? 'Delivery failed'],
      );
      summary.failed.push({ week_label: row.week_label, error: delivered.error ?? 'Delivery failed' });
      continue;
    }

    await pool.query(
      `UPDATE altus_weekly_brief_batches
          SET status = 'complete', completed_at = NOW()
        WHERE id = $1`,
      [row.id],
    );
    summary.completed.push({ week_label: row.week_label });
  }

  return summary;
}

async function persistAltusWeeklyBrief(briefText, weekLabel) {
  try {
    const now = new Date();
    const isoWeek = getIsoWeek(now);
    const sentAt = now.toISOString();

    const extractionPrompt = `Extract structured data from this Altus weekly brief email.
Return ONLY valid JSON with these exact fields:
{
  "top_recommendation": "single most urgent editorial action (one sentence)",
  "open_questions": ["question 1", "question 2"],
  "commitments_made": ["what Altus said it would do or watch"],
  "key_flags": ["persistent editorial issues or signals flagged"],
  "brief_summary": "2-3 sentence summary of the week"
}
Extract verbatim where possible. Return only JSON, no markdown, no preamble.`;

    const extracted = await generate({
      toolName: 'weekly_brief_extraction',
      system: 'You extract structured data from brief text.',
      prompt: `${extractionPrompt}\n\n---BRIEF---\n${briefText}`,
      maxTokens: 800,
    });

    let parsed = {};
    try {
      const cleaned = extracted.replace(/```json\s*/i, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = {
        top_recommendation: '',
        open_questions: [],
        commitments_made: [],
        key_flags: [],
        brief_summary: briefText.slice(0, 300),
      };
    }

    const weekKey = `altus:weekly_brief:${isoWeek}`;
    const briefRecord = {
      week_label: weekLabel,
      sent_at: sentAt,
      top_recommendation: parsed.top_recommendation || '',
      open_questions: parsed.open_questions || [],
      commitments_made: parsed.commitments_made || [],
      key_flags: parsed.key_flags || [],
      brief_summary: parsed.brief_summary || briefText.slice(0, 300),
      generated_by: 'weekly_cron',
    };

    await writeAgentMemory('altus', weekKey, JSON.stringify(briefRecord));
    await writeAgentMemory('altus', 'altus:weekly_brief:latest', JSON.stringify({
      week: isoWeek,
      week_label: weekLabel,
      sent_at: sentAt,
      top_recommendation: parsed.top_recommendation || '',
      key_flags_count: (parsed.key_flags || []).length,
      open_questions_count: (parsed.open_questions || []).length,
    }));

    logger.info('[altus-weekly-brief] Persisted weekly brief', { isoWeek, weekKey });
  } catch (err) {
    logger.warn('[altus-weekly-brief] Failed to persist weekly brief', { error: err.message });
  }
}

function buildWeeklyBriefHtml(weekLabel, briefHtml) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#f5f5f5;">
  <table width="600" cellpadding="0" cellspacing="0" style="margin:20px auto;background-color:#ffffff;border:1px solid #e0e0e0;">
    <tr>
      <td style="padding:20px 24px 16px 24px;border-bottom:2px solid #0066cc;">
        <h1 style="margin:0;font-family:Georgia,serif;font-size:22px;color:#1a1a1a;">AltWire Weekly Brief — ${weekLabel}</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px; font-family:Georgia,serif;font-size:14px;color:#1a1a1a;line-height:1.6;">
        ${briefHtml}
        <p style="margin-top:24px;font-size:12px;color:#666;">— Altus</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function formatWeekRange(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const opts = { month: 'long', day: 'numeric' };
  const mondayStr = monday.toLocaleDateString('en-US', opts);
  const sundayStr = sunday.toLocaleDateString('en-US', opts);
  const yearSuffix = monday.getFullYear() !== sunday.getFullYear()
    ? `, ${monday.getFullYear()}–${sunday.getFullYear()}`
    : `, ${sunday.getFullYear()}`;
  return `${mondayStr}–${sundayStr}${yearSuffix}`;
}

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
