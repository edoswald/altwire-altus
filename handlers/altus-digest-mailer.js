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

/**
 * getAiCostSummary returns { by_period: { today, week, month: { total_cost_usd } } }.
 * Older payloads used flat monthly_total/today_total — support both.
 */
function formatAiCosts(c) {
  if (!c) return null;
  const monthlyRaw = c.by_period?.month?.total_cost_usd ?? c.monthly_total;
  const todayRaw = c.by_period?.today?.total_cost_usd ?? c.today_total;
  return {
    monthly: monthlyRaw != null ? `$${Number(monthlyRaw).toFixed(2)}` : '—',
    today: todayRaw != null ? `$${Number(todayRaw).toFixed(2)}` : '—',
  };
}

/** Matomo returns bounce_rate as a string like "48%" — normalize to one % sign. */
function formatBounce(rate) {
  if (rate === undefined || rate === null || rate === '') return '—';
  return `${String(rate).replace(/%+$/, '')}%`;
}

/**
 * Summarize uptime across monitors, ignoring ones that no longer exist
 * in Better Stack ('not_monitored') so a deleted monitor doesn't flag
 * the whole site as having issues.
 */
function summarizeUptime(uptime) {
  const monitors = [
    ['site', uptime?.site?.status || 'unknown'],
    ['wp-cron', uptime?.wp_cron?.status || 'unknown'],
  ];
  const known = monitors.filter(([, status]) => status !== 'not_monitored');
  const ok = known.length > 0 && known.every(([, status]) => status === 'up');
  const detail = known.map(([name, status]) => `${name}: ${status}`).join(', ');
  return { ok, detail };
}

export function buildDigestHtml(digest) {
  const sections = [];
  const H = (label) => `<strong style="color:#0066cc;">${label}</strong>`;
  const row = (header, body) => `
    <tr><td style="padding:8px 0 4px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;">${header}</td></tr>
    <tr><td style="padding:0 0 12px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;">${body}</td></tr>
  `;

  // --- Site Status ---
  const uptimeSummary = summarizeUptime(digest.uptime);
  sections.push(row(H('SITE STATUS'),
    uptimeSummary.ok ? '✓ All systems operational' : `⚠ Issues detected — ${uptimeSummary.detail}`
  ));

  // --- Open Incidents ---
  if (digest.incidents?.site?.length > 0 || digest.incidents?.wp_cron?.length > 0) {
    const lines = [];
    for (const inc of (digest.incidents.site || [])) lines.push(`• ${inc.name}: ${inc.status}`);
    for (const inc of (digest.incidents.wp_cron || [])) lines.push(`• WP-Cron ${inc.name}: ${inc.status}`);
    sections.push(row(H('OPEN INCIDENTS'), lines.join('<br>')));
  }

  // --- Traffic (7d context + yesterday) ---
  const ft = digest.fresh_traffic?.period_7d;
  const hist = digest.historical?.traffic_summary;
  if (ft || digest.traffic) {
    const lines = [];
    if (ft) {
      const v7 = ft.nb_visits?.toLocaleString() || '—';
      const u7 = ft.nb_uniq_visitors?.toLocaleString() || '—';
      const b7 = formatBounce(ft.bounce_rate);
      lines.push(`7-day &nbsp;&mdash;&nbsp; Visits: ${v7} &nbsp;|&nbsp; Uniques: ${u7} &nbsp;|&nbsp; Bounce: ${b7}`);
    }
    if (digest.traffic) {
      const t = digest.traffic;
      const vY = t.nb_visits?.toLocaleString() || '—';
      const uY = t.nb_uniq_visitors?.toLocaleString() || '—';
      const pvY = t.nb_pageviews?.toLocaleString() || '—';
      lines.push(`Yesterday &nbsp;&mdash;&nbsp; Visits: ${vY} &nbsp;|&nbsp; Uniques: ${uY} &nbsp;|&nbsp; Pageviews: ${pvY}`);
    }
    if (hist) {
      const trend = hist.trend_direction ? `Trend: ${hist.trend_direction}` : null;
      const vsAvg = hist.vs_monthly_avg_pct !== undefined
        ? `vs. monthly avg: ${hist.vs_monthly_avg_pct >= 0 ? '+' : ''}${hist.vs_monthly_avg_pct}%`
        : null;
      const parts = [trend, vsAvg].filter(Boolean);
      if (parts.length) lines.push(`<span style="color:#555;">${parts.join(' &nbsp;|&nbsp; ')}</span>`);
    }
    sections.push(row(H('TRAFFIC'), lines.join('<br>')));
  }

  // --- Editorial Pulse (top articles this week) ---
  const articles = digest.fresh_top_articles?.articles;
  if (articles?.length > 0) {
    const top5 = articles.slice(0, 5).map((a, i) => {
      const pv = a.pageviews != null ? ` <span style="color:#555;">— ${Number(a.pageviews).toLocaleString()} views</span>` : '';
      return `${i + 1}. ${a.title || a.url || 'Unknown'}${pv}`;
    }).join('<br>');
    sections.push(row(H('EDITORIAL PULSE'), top5));
  }

  // --- Editorial Synthesis (expanded) ---
  const synth = digest.editorial_synthesis?.synthesis;
  if (synth?.headline) {
    const lines = [`<strong>${synth.headline}</strong>`];

    if (synth.search_traffic_share_pct != null) {
      lines.push(`<span style="color:#555;">Search-driven traffic: ~${synth.search_traffic_share_pct}% of visits</span>`);
    }

    if (synth.editorial_recommendation) {
      lines.push(`<br><em>${synth.editorial_recommendation}</em>`);
    }

    const dualWinners = asArray(synth.top_dual_winners);
    if (dualWinners.length > 0) {
      const winners = dualWinners.slice(0, 2)
        .map(a => `&nbsp;&nbsp;★ ${a.title} — <span style="color:#555;">${a.why}</span>`)
        .join('<br>');
      lines.push(`<br><span style="color:#0066cc;font-size:12px;">STRONG IN BOTH TRAFFIC &amp; SEARCH</span><br>${winners}`);
    }

    const underperforming = asArray(synth.underperforming_in_search);
    if (underperforming.length > 0) {
      const under = underperforming.slice(0, 2)
        .map(a => `&nbsp;&nbsp;↓ ${a.title} — <span style="color:#555;">${a.why}</span>`)
        .join('<br>');
      lines.push(`<br><span style="color:#0066cc;font-size:12px;">POPULAR BUT WEAK IN SEARCH</span><br>${under}`);
    }

    const contentGaps = asArray(synth.content_gaps);
    if (contentGaps.length > 0) {
      const gaps = contentGaps.slice(0, 3)
        .map(g => `&nbsp;&nbsp;• <strong>${g.query}</strong>${g.impressions ? ` (${Number(g.impressions).toLocaleString()} impressions)` : ''}`)
        .join('<br>');
      lines.push(`<br><span style="color:#0066cc;font-size:12px;">CONTENT GAPS</span><br>${gaps}`);
    }

    sections.push(row(H('EDITORIAL SYNTHESIS'), lines.join('\n')));
  }

  // --- Site Search Keywords ---
  const siteSearchKws = digest.site_search_keywords?.keywords;
  if (Array.isArray(siteSearchKws) && siteSearchKws.length > 0) {
    const kwList = siteSearchKws.slice(0, 7)
      .map(k => {
        const label = k.label ?? k.keyword ?? String(k);
        const nb = k.nb_searches ?? k.count ?? null;
        return nb ? `${label} <span style="color:#888;">(${nb})</span>` : label;
      })
      .join(' &nbsp;&middot;&nbsp; ');
    sections.push(row(H('READERS SEARCHING'), kwList));
  }

  // --- Rising Topics ---
  const rising = digest.historical?.rising_topics;
  if (rising?.length > 0) {
    sections.push(row(H('RISING TOPICS'), rising.join(' &nbsp;&middot;&nbsp; ')));
  }

  // --- News Alerts ---
  {
    const alertHtml = formatNewsAlerts(digest.news_alerts);
    sections.push(row(H('NEWS ALERTS'), alertHtml));
  }

  // --- Story Opportunities ---
  {
    const oppHtml = formatStoryOpportunities(digest.story_opportunities);
    sections.push(row(H('STORY OPPORTUNITIES'), oppHtml));
  }

  // --- Open Action Items (proposed from reflection) ---
  if (digest.open_action_items?.count > 0) {
    const items = digest.open_action_items.items.slice(0, 5).map(item => {
      const age = item.proposed_at
        ? Math.round((Date.now() - new Date(item.proposed_at).getTime()) / 3_600_000)
        : null;
      const ageStr = age != null ? ` <span style="color:#888;">(${age}h ago)</span>` : '';
      return `• ${item.title}${ageStr}`;
    }).join('<br>');
    sections.push(row(H('OPEN ITEMS'), items));
  }

  // --- Review Deadlines ---
  if (digest.review_deadlines?.count > 0) {
    const rd = digest.review_deadlines;
    const items = rd.reviews.slice(0, 5).map(r => {
      const due = r.due_date ? ` (due ${new Date(r.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})` : '';
      return `• ${r.title || 'Untitled'}${due}`;
    }).join('<br>');
    sections.push(row(H('EDITORIAL PIPELINE'), items));
  }

  // --- Overdue Loaners ---
  if (digest.overdue_loaners?.count > 0) {
    const names = digest.overdue_loaners.loaners.map(l => l.item_name || l.brand || 'Unknown item').join(', ');
    sections.push(row(H('OVERDUE LOANERS'), `${digest.overdue_loaners.count} overdue — ${names}`));
  }

  // --- AI Costs ---
  {
    const costs = formatAiCosts(digest.ai_costs);
    if (costs) sections.push(row(H('AI COSTS'), `Last 30 days: ${costs.monthly} &nbsp;|&nbsp; Today: ${costs.today}`));
  }

  // --- Warnings (genuine failures only — empty data is handled gracefully above) ---
  if (digest.warnings?.length > 0) {
    const warns = digest.warnings.map(w => `• ${w.section}: ${w.message}`).join('<br>');
    sections.push(`
      <tr><td style="padding:8px 0 4px 0;font-family:Georgia,serif;font-size:13px;color:#c00;"><strong>WARNINGS</strong></td></tr>
      <tr><td style="padding:0 0 12px 0;font-family:Georgia,serif;font-size:13px;color:#c00;">${warns}</td></tr>
    `);
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f5f5f5;">
  <table width="600" cellpadding="0" cellspacing="0" style="margin:20px auto;background-color:#ffffff;border:1px solid #e0e0e0;">
    <tr>
      <td style="padding:20px 24px 16px 24px;border-bottom:2px solid #0066cc;">
        <h1 style="margin:0;font-family:Georgia,serif;font-size:22px;color:#1a1a1a;">AltWire Morning — ${digest.date}</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 24px 8px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${sections.join('\n')}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function formatNewsAlerts(alerts) {
  if (!alerts) return '<span style="color:#888;">No Google News signals today</span>';

  // GSC News shape: { news_queries, watch_list_matches, news_pages, note? }
  if (alerts.watch_list_matches?.length > 0) {
    return alerts.watch_list_matches.slice(0, 5).map(m => {
      const imp = m.impressions ? ` — ${m.impressions.toLocaleString()} impressions` : '';
      return `⚡ <strong>${m.query}</strong> [${m.matched_items.join(', ')}]${imp}`;
    }).join('<br>');
  }

  if (alerts.news_queries?.length > 0) {
    return alerts.news_queries.slice(0, 5).map(q => {
      const imp = q.impressions ? ` (${q.impressions.toLocaleString()} impressions)` : '';
      return `• ${q.keys?.[0] || 'unknown'}${imp}`;
    }).join('<br>');
  }

  if (alerts.note) return `<span style="color:#888;">${alerts.note}</span>`;

  // Fallback for legacy string/array shapes
  if (typeof alerts === 'string') return alerts;
  if (Array.isArray(alerts)) {
    return alerts.map(a => `• ${typeof a === 'string' ? a : a.headline || a.title || JSON.stringify(a)}`).join('<br>');
  }
  if (alerts.headline) return `• ${alerts.headline}${alerts.url ? ` <a href="${alerts.url}">Read more</a>` : ''}`;

  return '<span style="color:#888;">No Google News signals today</span>';
}

function formatStoryOpportunities(opps) {
  if (!opps?.top?.length) return '<span style="color:#888;">No opportunities queued — runs weekdays at 5 AM ET</span>';

  const count = opps.count || opps.top.length;
  const lines = [`<strong>${count} opportunit${count !== 1 ? 'ies' : 'y'} flagged</strong>`];

  for (const o of opps.top.slice(0, 3)) {
    const imp = o.impressions ? ` (${Number(o.impressions).toLocaleString()} impressions)` : '';
    const coverage = o.coverageStatus ?? o.coverage_status;
    const gap = coverage ? ` — ${coverage.replace(/_/g, ' ')}` : '';
    lines.push(`• ${o.query ?? o.topic ?? o.title}${gap}${imp}`);
  }

  if (opps.pitches) {
    lines.push(`<br><span style="color:#444;font-style:italic;">${opps.pitches.replace(/\n/g, '<br>')}</span>`);
  }

  return lines.join('<br>');
}

function buildDigestText(digest) {
  const lines = [`AltWire Morning Digest — ${digest.date}`, ''];

  const uptimeSummary = summarizeUptime(digest.uptime);
  lines.push('SITE STATUS');
  lines.push(uptimeSummary.ok ? 'All systems operational' : `Issues — ${uptimeSummary.detail}`);

  if (digest.incidents?.site?.length > 0 || digest.incidents?.wp_cron?.length > 0) {
    lines.push('OPEN INCIDENTS');
    for (const inc of (digest.incidents.site || [])) lines.push(`• ${inc.name}: ${inc.status}`);
    for (const inc of (digest.incidents.wp_cron || [])) lines.push(`• WP-Cron ${inc.name}: ${inc.status}`);
  }

  const ft = digest.fresh_traffic?.period_7d;
  if (ft || digest.traffic) {
    lines.push('TRAFFIC');
    if (ft) lines.push(`7-day — Visits: ${ft.nb_visits?.toLocaleString() || '—'} | Uniques: ${ft.nb_uniq_visitors?.toLocaleString() || '—'} | Bounce: ${formatBounce(ft.bounce_rate)}`);
    if (digest.traffic) {
      const t = digest.traffic;
      lines.push(`Yesterday — Visits: ${t.nb_visits?.toLocaleString() || '—'} | Uniques: ${t.nb_uniq_visitors?.toLocaleString() || '—'} | Pageviews: ${t.nb_pageviews?.toLocaleString() || '—'}`);
    }
  }

  const articles = digest.fresh_top_articles?.articles;
  if (articles?.length > 0) {
    lines.push('EDITORIAL PULSE');
    articles.slice(0, 5).forEach((a, i) => {
      const pv = a.pageviews != null ? ` — ${Number(a.pageviews).toLocaleString()} views` : '';
      lines.push(`${i + 1}. ${a.title || a.url || 'Unknown'}${pv}`);
    });
  }

  const synth = digest.editorial_synthesis?.synthesis;
  if (synth?.headline) {
    lines.push('EDITORIAL SYNTHESIS');
    lines.push(synth.headline);
    if (synth.search_traffic_share_pct != null) lines.push(`Search-driven traffic: ~${synth.search_traffic_share_pct}%`);
    if (synth.editorial_recommendation) lines.push(synth.editorial_recommendation);
    const dualWinners = asArray(synth.top_dual_winners);
    if (dualWinners.length > 0) {
      lines.push('Strong in traffic + search:');
      dualWinners.slice(0, 2).forEach(a => lines.push(`  ★ ${a.title}`));
    }
    const contentGaps = asArray(synth.content_gaps);
    if (contentGaps.length > 0) {
      lines.push('Content gaps:');
      contentGaps.slice(0, 3).forEach(g => lines.push(`  • ${g.query}${g.impressions ? ` (${Number(g.impressions).toLocaleString()} impressions)` : ''}`));
    }
  }

  const siteSearchKws = digest.site_search_keywords?.keywords;
  if (Array.isArray(siteSearchKws) && siteSearchKws.length > 0) {
    const kwStr = siteSearchKws.slice(0, 7).map(k => k.label ?? k.keyword ?? String(k)).join(' · ');
    lines.push(`READERS SEARCHING: ${kwStr}`);
  }

  if (digest.historical?.rising_topics?.length > 0) {
    lines.push(`RISING TOPICS: ${digest.historical.rising_topics.join(' · ')}`);
  }

  lines.push('NEWS ALERTS');
  lines.push(formatNewsAlerts(digest.news_alerts).replace(/<[^>]+>/g, '').trim() || 'No Google News signals today');

  lines.push('STORY OPPORTUNITIES');
  lines.push(formatStoryOpportunities(digest.story_opportunities).replace(/<[^>]+>/g, '').trim() || 'None');

  if (digest.open_action_items?.count > 0) {
    lines.push(`OPEN ITEMS (${digest.open_action_items.count} proposed)`);
    digest.open_action_items.items.slice(0, 3).forEach(item => lines.push(`• ${item.title}`));
  }

  if (digest.review_deadlines?.count > 0) {
    lines.push(`EDITORIAL PIPELINE: ${digest.review_deadlines.count} review deadline(s) in next 7 days`);
  }

  if (digest.overdue_loaners?.count > 0) {
    const names = digest.overdue_loaners.loaners.map(l => l.item_name || l.brand || 'Unknown').join(', ');
    lines.push(`OVERDUE LOANERS: ${digest.overdue_loaners.count} overdue — ${names}`);
  }

  {
    const costs = formatAiCosts(digest.ai_costs);
    if (costs) lines.push(`AI COSTS: Last 30 days: ${costs.monthly} | Today: ${costs.today}`);
  }

  return lines.join('\n');
}