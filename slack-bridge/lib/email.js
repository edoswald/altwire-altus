/**
 * Email delivery for scheduled jobs (the daily digest): Markdown from the
 * agent → simple, inline-styled HTML that renders in mail clients, sent
 * through Amazon SES with the same credentials Altus uses.
 */

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const STYLE = {
  body: 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2328;max-width:680px;margin:0 auto;padding:16px;',
  h1: 'font-size:22px;margin:20px 0 8px;',
  h2: 'font-size:18px;margin:22px 0 8px;border-bottom:1px solid #d0d7de;padding-bottom:4px;',
  h3: 'font-size:16px;margin:18px 0 6px;',
  p: 'margin:0 0 12px;',
  list: 'margin:0 0 12px;padding-left:22px;',
  table: 'border-collapse:collapse;margin:0 0 14px;font-size:14px;',
  th: 'border:1px solid #d0d7de;padding:6px 10px;background:#f6f8fa;text-align:left;',
  td: 'border:1px solid #d0d7de;padding:6px 10px;vertical-align:top;',
  a: 'color:#0969da;',
  hr: 'border:none;border-top:1px solid #d0d7de;margin:18px 0;',
  code: 'font-family:SFMono-Regular,Menlo,monospace;font-size:13px;background:#f6f8fa;padding:1px 4px;border-radius:4px;',
};

/** Inline Markdown (bold, italic, code, links) on already-escaped text. */
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, `<code style="${STYLE.code}">$1</code>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, `<a href="$2" style="${STYLE.a}">$1</a>`)
    .replace(/&lt;(https?:\/\/[^|&\s]+)\|([^&]+)&gt;/g, `<a href="$1" style="${STYLE.a}">$2</a>`);
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l ?? '');
const isSeparator = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l ?? '');

/** Markdown → email-safe HTML fragment. Raw HTML in the input is escaped. */
export function markdownToEmailHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p style="${STYLE.p}">${inline(para.join(' '))}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level} style="${STYLE[`h${level}`]}">${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      out.push(`<hr style="${STYLE.hr}">`);
      continue;
    }
    if (isTableRow(line) && isSeparator(lines[i + 1])) {
      flush();
      const header = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      i -= 1;
      out.push(
        `<table style="${STYLE.table}"><thead><tr>${header.map((c) => `<th style="${STYLE.th}">${inline(c)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${header.map((_, j) => `<td style="${STYLE.td}">${inline(r[j] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      continue;
    }
    const listMatch = line.match(/^\s*([-*•]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      flush();
      const ordered = /\d/.test(listMatch[1]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*•]|\d+[.)])\s+(.+)$/);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        items.push(`<li>${inline(m[2])}</li>`);
        i += 1;
      }
      i -= 1;
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag} style="${STYLE.list}">${items.join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

/** Full HTML document for an email body. */
export function emailDocument(markdown, { footer } = {}) {
  return `<!doctype html><html><body style="margin:0;background:#ffffff;"><div style="${STYLE.body}">${markdownToEmailHtml(markdown)}`
    + `${footer ? `<p style="${STYLE.p}color:#656d76;font-size:12px;margin-top:24px;">${escapeHtml(footer)}</p>` : ''}</div></body></html>`;
}

/** Plain-text alternative: the Markdown with link syntax flattened. */
export function emailText(markdown) {
  return String(markdown ?? '').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
}

/**
 * @param {{ from: string, region?: string, accessKeyId?: string, secretAccessKey?: string }} opts
 * @returns {{ send: (msg: { to: string[], cc?: string[], subject: string, html: string, text: string }) => Promise<void> }}
 */
export function createSesMailer({ from, region = 'us-east-1', accessKeyId, secretAccessKey, client } = {}) {
  const ses = client ?? new SESClient({
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  return {
    async send({ to, cc = [], subject, html, text }) {
      await ses.send(new SendEmailCommand({
        Source: from,
        Destination: { ToAddresses: to, ...(cc.length ? { CcAddresses: cc } : {}) },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' } },
        },
      }));
    },
  };
}
