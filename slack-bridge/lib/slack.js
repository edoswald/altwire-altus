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

/**
 * Convert the Markdown Claude writes into Slack mrkdwn. Handles the common
 * cases (bold, headings, links, bullets); leaves code blocks untouched.
 */
export function toSlackMrkdwn(markdown) {
  const parts = String(markdown ?? '').split(/(```[\s\S]*?```)/g);
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
