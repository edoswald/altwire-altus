/**
 * Slack helpers: request signing, Web API calls, and Markdown → Slack mrkdwn.
 */

import crypto from 'node:crypto';

const MAX_SKEW_SECONDS = 60 * 5;

/**
 * Verify a Slack request signature (v0 scheme).
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature({ signingSecret, timestamp, signature, body, now = Date.now() }) {
  if (!signingSecret || !timestamp || !signature || typeof body !== 'string') return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) return false;
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim().replace(/\*\*(.+?)\*\*/g, '$1'));
}

/**
 * Slack has no tables. Render a Markdown pipe table as an aligned
 * monospace block so its columns still line up.
 */
export function tablesToCodeBlocks(text) {
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l ?? '');
    const isSeparator = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l ?? '');
    if (!(isRow(lines[i]) && isSeparator(lines[i + 1]))) {
      out.push(lines[i]);
      continue;
    }
    const rows = [tableCells(lines[i])];
    i += 2;
    while (i < lines.length && isRow(lines[i])) rows.push(tableCells(lines[i++]));
    i -= 1;
    const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length)));
    const render = (r) => widths.map((w, col) => (r[col] ?? '').padEnd(w)).join('  ').trimEnd();
    out.push('```', render(rows[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(render), '```');
  }
  return out.join('\n');
}

/**
 * Convert the Markdown Claude writes into Slack mrkdwn. Handles the common
 * cases (bold, headings, links, bullets); leaves code blocks untouched.
 */
export function toSlackMrkdwn(markdown) {
  const parts = tablesToCodeBlocks(String(markdown ?? '')).split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part; // fenced code block
    return part
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '*$1*')
      .replace(/^#{1,6}\s+(.+)$/gm, (_, heading) => `*${heading.replace(/\*/g, '')}*`)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
      .replace(/^(\s*)[-*]\s+/gm, '$1• ');
  }).join('');
}

/** Split text into Slack-sized chunks, preferring paragraph then line breaks. */
export function chunkText(text, max = 3500) {
  const chunks = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length || !chunks.length) chunks.push(rest);
  return chunks;
}

export class SlackClient {
  constructor({ token, fetchImpl = fetch }) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async call(method, payload) {
    const res = await this.fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`);
    return data;
  }

  /** Form-encoded Web API call (some file methods don't accept JSON bodies). */
  async callForm(method, params) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null) body.set(k, String(v));
    const res = await this.fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${this.token}` },
      body: body.toString(),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`);
    return data;
  }

  /**
   * Upload a file into a channel or thread (files.getUploadURLExternal →
   * upload → files.completeUploadExternal). Needs the files:write scope.
   */
  async uploadFile({ channel, thread_ts, filename, bytes, title }) {
    const { upload_url: uploadUrl, file_id: fileId } = await this.callForm('files.getUploadURLExternal', {
      filename,
      length: bytes.length,
    });
    const put = await this.fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    if (!put.ok) throw new Error(`Slack file upload failed (${put.status})`);
    await this.callForm('files.completeUploadExternal', {
      files: JSON.stringify([{ id: fileId, title: title ?? filename }]),
      channel_id: channel,
      thread_ts,
    });
    return fileId;
  }

  authTest() {
    return this.call('auth.test', {});
  }

  post({ channel, text, thread_ts }) {
    return this.call('chat.postMessage', { channel, text, thread_ts, unfurl_links: false, unfurl_media: false });
  }

  update({ channel, ts, text }) {
    return this.call('chat.update', { channel, ts, text });
  }

  async openDm(user) {
    const data = await this.call('conversations.open', { users: user });
    return data.channel.id;
  }
}
