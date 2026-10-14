import { getAltwireMorningDigest } from './altus-digest.js';
import { sendEmail } from '../lib/ses-client.js';
import { logger } from '../logger.js';
import { writeAgentMemory, readAgentMemory } from '../lib/altus-db.js';

// Tracks the outcome of the most recent digest send so a missed or failed run
// can be retried at the next opportunity (e.g. during the heartbeat).
const DIGEST_STATUS_KEY = 'altus:digest:send_status';

// The digest is scheduled Mon–Fri at 5:15 AM ET. The retry must not fire before
// that slot (it would preempt the scheduled send and cause a duplicate).
const DIGEST_SCHEDULED_MINUTES = 5 * 60 + 15; // 05:15 ET

// Calendar date (YYYY-MM-DD) and weekday/minute-of-day in America/New_York —
// matches the timezone the digest date and cron are anchored to.
function easternNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  const weekday = get('weekday'); // 'Mon'..'Sun'
  return { date, weekday, minutesOfDay: hour * 60 + minute };
}

async function recordDigestStatus(status) {
  await writeAgentMemory('altus', DIGEST_STATUS_KEY, JSON.stringify(status))
    .catch((err) => logger.warn('[altus-digest-mailer] Failed to record digest status', { error: err.message }));
}

// The editorial synthesis is produced by an LLM tool call and stored in agent
// memory. Although the tool schema declares array fields, the model occasionally
// returns a non-array (e.g. a string), which still passes `?.length > 0` and
// supports `.slice()` but not `.map()`/`.forEach()`. Coerce defensively so a
// malformed synthesis can never crash the digest send.
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Build and send the morning digest email.
 *
 * @returns {Promise<{ status: 'sent'|'failed'|'skipped', date?: string, reason?: string, error?: string }>}
 *   A structured result so callers (e.g. the heartbeat retry) can tell whether
 *   the send succeeded without re-deriving it from logs.
 */
export async function sendMorningDigestEmail() {
  if (!process.env.DEREK_EMAIL) {
    logger.warn('[altus-digest-mailer] DEREK_EMAIL not set — skipping digest send');
    return { status: 'skipped', reason: 'no_recipient' };
  }

  // ALTUS_CC_EMAILS: comma-separated list of addresses to CC on every digest.
  // Set this to your own address during testing so you don't need Derek to forward.
  const ccAddresses = process.env.ALTUS_CC_EMAILS
    ? process.env.ALTUS_CC_EMAILS.split(',').map(e => e.trim()).filter(Boolean)
    : [];

  let digestDate;
  try {
    const digest = await getAltwireMorningDigest();
    digestDate = digest.date;
    const subject = `AltWire Morning Digest — ${digest.date}`;
    const html = buildDigestHtml(digest);
    const text = buildDigestText(digest);

    const result = await sendEmail({ to: process.env.DEREK_EMAIL, cc: ccAddresses, subject, html, text });
    if (result.success) {
      const ccNote = ccAddresses.length ? ` (CC: ${ccAddresses.join(', ')})` : '';
      logger.info(`[altus-digest-mailer] Sent morning digest to Derek${ccNote} — ${digest.date}`);
      // Archive the rendered HTML so it can be retrieved via /altwire/digest/archive
      await writeAgentMemory('altus', `altus:digest_archive:${digest.date}`, JSON.stringify({
        date: digest.date,
        subject,
        html,
        sent_at: new Date().toISOString(),
      })).catch(err => logger.warn('[altus-digest-mailer] Failed to archive digest HTML', { error: err.message }));
      await recordDigestStatus({ status: 'sent', date: digest.date, sent_at: new Date().toISOString() });
      return { status: 'sent', date: digest.date };
    }

    logger.error(`[altus-digest-mailer] Failed to send morning digest to Derek — ${result.error}`);
    await recordDigestStatus({ status: 'failed', date: digest.date, failed_at: new Date().toISOString(), error: result.error });
    return { status: 'failed', date: digest.date, error: result.error };
  } catch (err) {
    logger.error('[altus-digest-mailer] Failed to send morning digest', { error: err.message });
    await recordDigestStatus({ status: 'failed', date: digestDate ?? null, failed_at: new Date().toISOString(), error: err.message });
    return { status: 'failed', date: digestDate, error: err.message };
  }
}

/**
 * Self-healing retry: send today's digest if the scheduled run was missed or
 * failed. Safe to call repeatedly (e.g. from the heartbeat) — it sends at most
 * once per day and never preempts the scheduled 5:15 AM ET send.
 *
 * @returns {Promise<{ status: 'sent'|'failed'|'skipped', reason?: string, date?: string, error?: string }>}
 */
export async function sendMorningDigestIfMissed() {
  const { date, weekday, minutesOfDay } = easternNow();

  // The digest only runs Mon–Fri; don't resurrect a stale digest on weekends.
  if (weekday === 'Sat' || weekday === 'Sun') {
    return { status: 'skipped', reason: 'weekend' };
  }

  // Don't fire before the scheduled slot — that would duplicate the cron send.
  if (minutesOfDay < DIGEST_SCHEDULED_MINUTES) {
    return { status: 'skipped', reason: 'before_scheduled_time' };
  }

  // Already sent today? Nothing to do.
  const existing = await readAgentMemory('altus', DIGEST_STATUS_KEY);
  if (existing.success) {
    try {
      const status = JSON.parse(existing.value);
      if (status.status === 'sent' && status.date === date) {
        return { status: 'skipped', reason: 'already_sent', date };
      }
    } catch {
      // Corrupt status — fall through and attempt a send.
    }
  }

  logger.info('[altus-digest-mailer] Today\'s digest not yet sent — attempting retry', { date });
  return sendMorningDigestEmail();
}

// ---------------------------------------------------------------------------
// Rendering
//
// Sections are built once as { title, lines } and rendered to both HTML and
// plain text, so the two formats can't drift apart. A line is a string or
// { text, tone } where tone is 'strong', 'muted' or 'label'.
// ---------------------------------------------------------------------------

const MINUS = '−';

function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Math.round(Number(n)).toLocaleString('en-US');
}

function fmtPct(p) {
  if (p === null || p === undefined) return null;
  if (p === 0) return '0%';
  return `${p > 0 ? '+' : MINUS}${Math.abs(p).toFixed(1)}%`;
}

function fmtChange(n) {
  if (!n) return '±0';
  return `${n > 0 ? '+' : MINUS}${fmtNum(Math.abs(n))}`;
}

/** "1,234 visits (+5.0%)" from a compareTotals entry. */
function metric(entry, noun) {
  if (!entry || entry.current == null) return null;
  const pct = fmtPct(entry.change_pct);
  return `${fmtNum(entry.current)} ${noun}${pct ? ` (${pct})` : ''}`;
}

/** Matomo bounce_rate arrives as "48%"; normalize to a single % sign. */
function formatBounce(rate) {
  if (rate === undefined || rate === null || rate === '') return null;
  return `${String(rate).replace(/%+$/, '')}%`;
}

/** Readable label for a URL: its path without slashes. */
function pageLabel(url, fallback) {
  if (fallback && !String(fallback).startsWith('http')) return String(fallback).replace(/^\/+|\/+$/g, '');
  try {
    const path = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
    return path || url;
  } catch {
    return url ?? 'unknown';
  }
}

function moverLines(movers, { unit, labelOf = (m) => m.label ?? m.key, limit = 3 }) {
  const lines = [];
  if (movers?.risers?.length) {
    lines.push({ text: 'Up', tone: 'label' });
    for (const m of movers.risers.slice(0, limit)) lines.push(`↑ ${labelOf(m)} — ${fmtNum(m.current)} ${unit} (${fmtChange(m.change)})`);
  }
  if (movers?.fallers?.length) {
    lines.push({ text: 'Down', tone: 'label' });
    for (const m of movers.fallers.slice(0, limit)) lines.push(`↓ ${labelOf(m)} — ${fmtNum(m.current)} ${unit} (${fmtChange(m.change)})`);
  }
  return lines;
}

function numbersSection(digest) {
  const a = digest.analytics;
  const lines = [];

  if (a?.traffic) {
    const parts = [
      metric(a.traffic.nb_visits, 'visits'),
      metric(a.traffic.nb_pageviews, 'pageviews'),
      metric(a.traffic.nb_uniq_visitors, 'uniques'),
    ].filter(Boolean);
    if (parts.length) lines.push(`Last ${a.days} days: ${parts.join(' · ')}`);
  }

  const y = a?.yesterday_vs_last_week;
  if (y?.nb_visits) {
    const pct = fmtPct(y.nb_visits.change_pct);
    const pv = y.nb_pageviews?.current != null ? ` · ${fmtNum(y.nb_pageviews.current)} pageviews` : '';
    lines.push(`Yesterday: ${fmtNum(y.nb_visits.current)} visits${pct ? ` (${pct} vs same day last week)` : ''}${pv}`);
  } else if (digest.traffic) {
    const t = digest.traffic;
    lines.push(`Yesterday: ${fmtNum(t.nb_visits)} visits · ${fmtNum(t.nb_pageviews)} pageviews`);
  }

  const s = a?.search?.totals;
  if (s?.clicks) {
    const parts = [metric(s.clicks, 'clicks'), metric(s.impressions, 'impressions')].filter(Boolean);
    if (s.position?.current != null) {
      const prev = s.position.previous != null ? ` (was ${Number(s.position.previous).toFixed(1)})` : '';
      parts.push(`avg position ${Number(s.position.current).toFixed(1)}${prev}`);
    }
    lines.push(`Search, ${a.days} days to ${a.windows?.gsc?.current?.[1] ?? '—'}: ${parts.join(' · ')}`);
  }

  const bounce = formatBounce(a?.traffic?.bounce_rate?.current);
  const hist = digest.historical?.traffic_summary;
  const context = [
    bounce ? `Bounce ${bounce}` : null,
    hist?.trend_direction ? `18-month trend: ${hist.trend_direction}` : null,
  ].filter(Boolean);
  if (context.length) lines.push({ text: context.join(' · '), tone: 'muted' });

  return lines.length ? { title: 'THE NUMBERS', lines } : null;
}

function trafficMoversSection(a) {
  const lines = moverLines(a?.page_movers, { unit: 'views', labelOf: (m) => pageLabel(m.key, m.label) });
  return lines.length ? { title: `TRAFFIC MOVERS (${a.days}d vs prior ${a.days}d)`, lines } : null;
}

function searchMoversSection(a) {
  const lines = [];
  const q = moverLines(a?.search?.query_movers, { unit: 'clicks' });
  if (q.length) lines.push({ text: 'Queries', tone: 'strong' }, ...q);
  const p = moverLines(a?.search?.page_movers, { unit: 'clicks', labelOf: (m) => pageLabel(m.key) });
  if (p.length) lines.push({ text: 'Pages', tone: 'strong' }, ...p);
  return lines.length ? { title: 'SEARCH MOVERS', lines } : null;
}

function opportunityZoneSection(a) {
  if (!a?.opportunity_zone_new?.length) return null;
  return {
    title: 'NEW IN SEARCH POSITIONS 5–30',
    lines: [
      { text: 'Queries that started ranking within reach this week; a refresh or follow-up could push them onto page one.', tone: 'muted' },
      ...a.opportunity_zone_new.map((e) => `• ${e.query} — position ${e.position ?? '—'}, ${fmtNum(e.impressions)} impressions${e.page ? ` → ${pageLabel(e.page)}` : ''}`),
    ],
  };
}

function googleNewsSection(a) {
  const n = a?.google_news;
  if (!n) return null;
  if (!n.total_impressions) return { title: 'GOOGLE NEWS', lines: [{ text: `No Google News impressions in the last ${a.days} days`, tone: 'muted' }] };
  return {
    title: 'GOOGLE NEWS',
    lines: [
      `${fmtNum(n.total_clicks)} clicks · ${fmtNum(n.total_impressions)} impressions in the last ${a.days} days`,
      ...n.top_pages.slice(0, 3).map((p) => `• ${pageLabel(p.url)} — ${fmtNum(p.clicks)} clicks, ${fmtNum(p.impressions)} impressions`),
    ],
  };
}

function recentArticlesSection(a) {
  if (!a?.recent_articles?.length) return null;
  return {
    title: 'RECENT ARTICLES (last 14 days)',
    lines: a.recent_articles.slice(0, 6).map((r) => {
      const parts = [`${fmtNum(r.pageviews)} views`, `${fmtNum(r.search_clicks)} search clicks`];
      if (r.avg_position != null) parts.push(`position ${r.avg_position}`);
      return `• ${r.title} — ${parts.join(' · ')}`;
    }),
  };
}

function topPagesSection(a) {
  if (!a?.top_pages?.length) return null;
  return {
    title: 'TOP ARTICLES THIS WEEK',
    lines: a.top_pages.map((p, i) => `${i + 1}. ${pageLabel(p.url, p.label)} — ${fmtNum(p.pageviews)} views`),
  };
}

function synthesisSections(digest) {
  const synth = digest.editorial_synthesis?.synthesis;
  if (!synth?.headline) return [];
  const lines = [{ text: synth.headline, tone: 'strong' }];
  if (synth.search_traffic_share_pct != null) lines.push({ text: `Search-driven traffic: ~${synth.search_traffic_share_pct}% of visits`, tone: 'muted' });
  if (synth.editorial_recommendation) lines.push(synth.editorial_recommendation);

  const dualWinners = asArray(synth.top_dual_winners);
  if (dualWinners.length) {
    lines.push({ text: 'Strong in both traffic and search', tone: 'label' });
    for (const w of dualWinners.slice(0, 2)) lines.push(`★ ${w.title} — ${w.why}`);
  }
  const underperforming = asArray(synth.underperforming_in_search);
  if (underperforming.length) {
    lines.push({ text: 'Popular but weak in search', tone: 'label' });
    for (const u of underperforming.slice(0, 2)) lines.push(`↓ ${u.title} — ${u.why}`);
  }

  const sections = [{ title: 'EDITORIAL SYNTHESIS', lines }];
  const gaps = asArray(synth.content_gaps);
  if (gaps.length) {
    sections.push({
      title: 'SEARCH DEMAND GAPS',
      lines: [
        { text: 'Queries people search for that the archive does not cover well.', tone: 'muted' },
        ...gaps.slice(0, 4).map((g) => `• ${g.query}${g.impressions ? ` (${fmtNum(g.impressions)} impressions)` : ''}`),
      ],
    });
  }
  return sections;
}

function newsAlertLines(alerts) {
  const none = [{ text: 'No watch-list or Google News signals today', tone: 'muted' }];
  if (!alerts) return none;
  if (alerts.watch_list_matches?.length) {
    return alerts.watch_list_matches.slice(0, 5).map((m) => {
      const who = m.name ?? (Array.isArray(m.matched_items) ? m.matched_items.join(', ') : null);
      const imp = m.impressions ? ` — ${fmtNum(m.impressions)} impressions` : '';
      return `⚡ ${m.query}${who ? ` [${who}]` : ''}${imp}`;
    });
  }
  if (alerts.news_queries?.length) {
    return alerts.news_queries.slice(0, 5).map((q) => `• ${q.keys?.[0] || 'unknown'}${q.impressions ? ` (${fmtNum(q.impressions)} impressions)` : ''}`);
  }
  if (alerts.note) return [{ text: alerts.note, tone: 'muted' }];
  return none;
}

function storyOpportunityLines(opps) {
  if (!opps?.top?.length) return [{ text: 'No opportunities queued — the queue refreshes weekdays at 5 AM ET', tone: 'muted' }];
  const count = opps.count || opps.top.length;
  const lines = [{ text: `${count} opportunit${count !== 1 ? 'ies' : 'y'} in the queue`, tone: 'strong' }];
  for (const o of opps.top.slice(0, 5)) {
    const signal = [
      o.impressions ? `${fmtNum(o.impressions)} impressions` : null,
      o.position != null ? `position ${Number(o.position).toFixed(1)}` : null,
      o.coverage_status ? o.coverage_status.replace(/_/g, ' ') : null,
    ].filter(Boolean).join(', ');
    lines.push(`• ${o.topic ?? o.title}${signal ? ` — ${signal}` : ''}`);
  }
  return lines;
}

/** Ordered section list shared by the HTML and text renderers. */
export function buildDigestSections(digest) {
  const a = digest.analytics;
  const sections = [
    numbersSection(digest),
    trafficMoversSection(a),
    searchMoversSection(a),
    opportunityZoneSection(a),
    googleNewsSection(a),
    recentArticlesSection(a),
    topPagesSection(a),
    ...synthesisSections(digest),
  ];

  const kws = digest.site_search_keywords?.keywords;
  if (Array.isArray(kws) && kws.length) {
    sections.push({
      title: 'READERS SEARCHING ON ALTWIRE',
      lines: [kws.slice(0, 7).map((k) => {
        const label = k.label ?? k.keyword ?? String(k);
        const nb = k.nb_searches ?? k.count ?? null;
        return nb ? `${label} (${nb})` : label;
      }).join(' · ')],
    });
  }

  if (digest.historical?.rising_topics?.length) {
    sections.push({ title: 'RISING TOPICS', lines: [digest.historical.rising_topics.join(' · ')] });
  }

  sections.push({ title: 'WATCH LIST & NEWS ALERTS', lines: newsAlertLines(digest.news_alerts) });
  sections.push({ title: 'STORY OPPORTUNITIES', lines: storyOpportunityLines(digest.story_opportunities) });

  if (digest.warnings?.length) {
    sections.push({
      title: 'DATA WARNINGS',
      tone: 'warning',
      lines: digest.warnings.map((w) => `• ${w.section}: ${w.message}`),
    });
  }

  return sections.filter(Boolean);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LINE_STYLES = {
  strong: 'font-weight:bold;',
  muted: 'color:#666;',
  label: 'color:#0066cc;font-size:12px;letter-spacing:0.03em;padding-top:4px;',
};

export function buildDigestHtml(digest) {
  const body = buildDigestSections(digest).map((section) => {
    const color = section.tone === 'warning' ? '#c00' : '#0066cc';
    const lines = section.lines.map((line) => {
      const { text, tone } = typeof line === 'string' ? { text: line, tone: null } : line;
      const style = LINE_STYLES[tone] ?? '';
      return `<div style="${style}">${escapeHtml(text)}</div>`;
    }).join('\n');
    return `
    <tr><td style="padding:12px 0 4px 0;font-family:Georgia,serif;font-size:13px;color:${color};"><strong>${escapeHtml(section.title)}</strong></td></tr>
    <tr><td style="padding:0 0 8px 0;font-family:Georgia,serif;font-size:13px;line-height:1.5;color:${section.tone === 'warning' ? '#c00' : '#1a1a1a'};">${lines}</td></tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f5f5f5;">
  <table width="600" cellpadding="0" cellspacing="0" style="margin:20px auto;background-color:#ffffff;border:1px solid #e0e0e0;">
    <tr>
      <td style="padding:20px 24px 16px 24px;border-bottom:2px solid #0066cc;">
        <h1 style="margin:0;font-family:Georgia,serif;font-size:22px;color:#1a1a1a;">AltWire Morning — ${escapeHtml(digest.date)}</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:8px 24px 16px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${body}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildDigestText(digest) {
  const out = [`AltWire Morning Digest — ${digest.date}`];
  for (const section of buildDigestSections(digest)) {
    out.push('', section.title);
    for (const line of section.lines) out.push(typeof line === 'string' ? line : line.text);
  }
  return out.join('\n');
}
