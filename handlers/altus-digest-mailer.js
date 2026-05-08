import { getAltwireMorningDigest } from './altus-digest.js';
import { sendEmail } from '../lib/ses-client.js';
import { logger } from '../logger.js';

export async function sendMorningDigestEmail() {
  if (!process.env.DEREK_EMAIL) {
    logger.warn('[altus-digest-mailer] DEREK_EMAIL not set — skipping digest send');
    return;
  }

  try {
    const digest = await getAltwireMorningDigest();
    const subject = `AltWire Morning Digest — ${digest.date}`;
    const html = buildDigestHtml(digest);
    const text = buildDigestText(digest);

    await sendEmail({ to: process.env.DEREK_EMAIL, subject, html, text });
    logger.info(`[altus-digest-mailer] Sent morning digest to Derek — ${digest.date}`);
  } catch (err) {
    logger.error('[altus-digest-mailer] Failed to send morning digest', { error: err.message });
  }
}

function buildDigestHtml(digest) {
  const sections = [];

  const siteStatus = digest.uptime?.site?.status || 'unknown';
  const wpStatus = digest.uptime?.wp_cron?.status || 'unknown';
  const siteOk = siteStatus === 'up' && wpStatus === 'up';
  sections.push(`
    <tr><td style="padding:8px 0 4px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;"><strong style="color:#0066cc;">SITE STATUS</strong></td></tr>
    <tr><td style="padding:0 0 12px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;">
      ${siteOk ? '✓ All systems operational' : `⚠ Issues detected — site: ${siteStatus}, wp-cron: ${wpStatus}`}
    </td></tr>
  `);

  if (digest.incidents?.site?.length > 0 || digest.incidents?.wp_cron?.length > 0) {
    const incidentList = [];
    for (const inc of (digest.incidents.site || [])) {
      incidentList.push(`• ${inc.name}: ${inc.status}`);
    }
    for (const inc of (digest.incidents.wp_cron || [])) {
      incidentList.push(`• WP-Cron ${inc.name}: ${inc.status}`);
    }
    sections.push(`
      <tr><td style="padding:8px 0 4px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;"><strong style="color:#0066cc;">OPEN INCIDENTS</strong></td></tr>
      <tr><td style="padding:0 0 12px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;">${incidentList.join('<br>')}</td></tr>
    `);
  }

  if (digest.news_alerts) {
    sections.push(`
      <tr><td style="padding:8px 0 4px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;"><strong style="color:#0066cc;">NEWS ALERTS</strong></td></tr>
      <tr><td style="padding:0 0 12px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;">${formatNewsAlerts(digest.news_alerts)}</td></tr>
    `);
  }

  if (digest.story_opportunities?.top?.length > 0) {
    const opps = digest.story_opportunities.top.map(o => {
      const score = o.score ? ` (score: ${o.score.toFixed(2)})` : '';
      return `• ${o.title || o.topic || 'Opportunity'}${score}`;
    }).join('<br>');
    sections.push(`
      <tr><td style="padding:8px 0 4px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;"><strong style="color:#0066cc;">STORY OPPORTUNITIES</strong></td></tr>
      <tr><td style="padding:0 0 12px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;">${opps}</td></tr>
    `);
  }

  if (digest.review_deadlines?.count > 0) {
    const rd = digest.review_deadlines;
    sections.push(`
      <tr><td style="padding:8px 0 4px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;"><strong style="color:#0066cc;">EDITORIAL PIPELINE</strong></td></tr>
      <tr><td style="padding:0 0 12px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;">
        ${rd.count} review deadline${rd.count !== 1 ? 's' : ''} in next 7 days
      </td></tr>
    `);
  }

  if (digest.overdue_loaners?.count > 0) {
    const names = digest.overdue_loaners.loaners.map(l => l.item_name || l.brand || 'Unknown item').join(', ');
    sections.push(`
      <tr><td style="padding:8px 0 4px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;"><strong style="color:#0066cc;">OVERDUE LOANERS</strong></td></tr>
      <tr><td style="padding:0 0 12px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;">
        ${digest.overdue_loaners.count} overdue — ${names}
      </td></tr>
    `);
  }

  if (digest.traffic) {
    const t = digest.traffic;
    const visits = t.nb_visits?.toLocaleString() || '—';
    const visitors = t.nb_uniq_visitors?.toLocaleString() || '—';
    const pageviews = t.nb_pageviews?.toLocaleString() || '—';
    const bounce = t.bounce_rate !== undefined ? `${t.bounce_rate}%` : '—';
    sections.push(`
      <tr><td style="padding:8px 0 4px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;"><strong style="color:#0066cc;">TRAFFIC (Yesterday)</strong></td></tr>
      <tr><td style="padding:0 0 12px 0;font-family:Georgia,serif;font-size:13px;color:#1a1a1a;">
        Visits: ${visits} &nbsp;|&nbsp; Unique visitors: ${visitors} &nbsp;|&nbsp; Pageviews: ${pageviews} &nbsp;|&nbsp; Bounce: ${bounce}
      </td></tr>
    `);
  }

  if (digest.warnings?.length > 0) {
    const warns = digest.warnings.map(w => `• ${w.section}: ${w.message}`).join('<br>');
    sections.push(`
      <tr><td style="padding:8px 0 4px 0;font-family:Georgia,serif;font-size:13px;color:#c00;"><strong>WARNINGS</strong></td></tr>
      <tr><td style="padding:0 0 12px 0;font-family:Georgia,serif;font-size:13px;color:#c00;">${warns}</td></tr>
    `);
  }

  const bodyRows = sections.join('\n');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
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
          ${bodyRows}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function formatNewsAlerts(alerts) {
  if (!alerts) return '';
  if (typeof alerts === 'string') return alerts;
  if (Array.isArray(alerts)) {
    return alerts.map(a => `• ${typeof a === 'string' ? a : a.headline || a.title || JSON.stringify(a)}`).join('<br>');
  }
  if (alerts.headline) return `• ${alerts.headline}${alerts.url ? ` <a href="${alerts.url}">Read more</a>` : ''}`;
  return JSON.stringify(alerts);
}

function buildDigestText(digest) {
  const lines = [`AltWire Morning Digest — ${digest.date}`, '', 'SITE STATUS'];
  const siteStatus = digest.uptime?.site?.status || 'unknown';
  const wpStatus = digest.uptime?.wp_cron?.status || 'unknown';
  lines.push(siteStatus === 'up' && wpStatus === 'up' ? 'All systems operational' : `Issues — site: ${siteStatus}, wp-cron: ${wpStatus}`);
  if (digest.incidents?.site?.length > 0) {
    lines.push('OPEN INCIDENTS');
    for (const inc of digest.incidents.site) lines.push(`• ${inc.name}: ${inc.status}`);
  }
  if (digest.news_alerts) {
    lines.push('NEWS ALERTS');
    lines.push(formatNewsAlerts(digest.news_alerts).replace(/<[^>]+>/g, ''));
  }
  if (digest.story_opportunities?.top?.length > 0) {
    lines.push('STORY OPPORTUNITIES');
    for (const o of digest.story_opportunities.top) {
      const score = o.score ? ` (score: ${o.score.toFixed(2)})` : '';
      lines.push(`• ${o.title || o.topic || 'Opportunity'}${score}`);
    }
  }
  if (digest.review_deadlines?.count > 0) {
    lines.push(`EDITORIAL PIPELINE: ${digest.review_deadlines.count} review deadline(s) in next 7 days`);
  }
  if (digest.overdue_loaners?.count > 0) {
    const names = digest.overdue_loaners.loaners.map(l => l.item_name || l.brand || 'Unknown').join(', ');
    lines.push(`OVERDUE LOANERS: ${digest.overdue_loaners.count} overdue — ${names}`);
  }
  if (digest.traffic) {
    const t = digest.traffic;
    lines.push('TRAFFIC (Yesterday)');
    lines.push(`Visits: ${t.nb_visits?.toLocaleString() || '—'} | Unique visitors: ${t.nb_uniq_visitors?.toLocaleString() || '—'} | Pageviews: ${t.nb_pageviews?.toLocaleString() || '—'} | Bounce: ${t.bounce_rate !== undefined ? t.bounce_rate + '%' : '—'}`);
  }
  return lines.join('\n');
}