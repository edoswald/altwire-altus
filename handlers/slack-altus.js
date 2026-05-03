/**
 * handlers/slack-altus.js — Slack integration for Altus MCP server.
 *
 * Provides:
 *   postStatusUpdate(...)       — Hal-initiated status posts with channel routing
 *   getSlackPostHistory(...)    — Query recent Hal-initiated Slack posts
 *   initSlackAltusSchema()      — Create hal_slack_posts table
 *   handleSlackRequest(req,res) — HTTP handler for /slack/events (inbound events)
 *   dispatchSlackEvent(event)   — Route inbound Slack events to the right handler
 *
 * Uses @slack/bolt with receiver: false and manual request processing.
 * Outbound status posting and event dispatch use the same Bolt app.
 * Inbound event routing is specific to Altus — AltWire-channel events
 * are dispatched here and routed to nimbus for the Hal session.
 *
 * Exports:
 *   initSlackAltus()            — startup init (creates Bolt app, stores bot user ID)
 *   handleSlackRequest(req, res) — raw HTTP handler for /slack/events
 *   dispatchSlackEvent(event)    — dispatch an event payload to the right handler
 *   postStatusUpdate(...)       — post a status update to a Slack channel
 *   getSlackPostHistory(...)    — query recent posts from hal_slack_posts
 *   formatForSlack(markdown)    — Markdown → Slack mrkdwn conversion (pure)
 *   splitMessage(text, limit)    — split long messages into chunks (pure)
 *   stripMentions(text, botUserId) — remove <@BOT_ID> tokens (pure)
 *   getChannels()                — channel ID map from env vars (pure)
 *   getChannelContext(channelId) — channel metadata for system prompt (pure)
 */

import crypto from 'node:crypto';
import { logger } from '../logger.js';

let slackApp = null;
let halBotUserId = null;
let halBotId = null;
let signingSecret = null;

// ---------------------------------------------------------------------------
// Channel IDs from env
// ---------------------------------------------------------------------------

export function getChannels() {
  return {
    altwire: process.env.SLACK_CHANNEL_ALTWIRE,
    adminAnnouncements: process.env.SLACK_CHANNEL_ADMIN_ANNOUNCEMENTS,
    bugReports: process.env.SLACK_CHANNEL_BUG_REPORTS,
    watercooler: process.env.SLACK_CHANNEL_WATERCOOLER,
  };
}

/**
 * Return channel context metadata for a given channel ID.
 *
 * @param {string} channelId
 * @returns {{ name: string, purpose: string, halRole: string, adminContext: boolean, agentContext?: string }}
 */
export function getChannelContext(channelId) {
  const ch = getChannels();
  const map = Object.create(null);

  if (ch.adminAnnouncements) {
    map[ch.adminAnnouncements] = {
      name: 'admin-announcements',
      purpose: 'Operational status updates, incidents, escalations, and business alerts for admins.',
      halRole: 'primary_posting',
      adminContext: true,
    };
  }
  if (ch.bugReports) {
    map[ch.bugReports] = {
      name: 'bug-reports',
      purpose: "Dave coding agent's primary channel. Hal posts Dave's weekly digest here. Hal otherwise stays out.",
      halRole: 'dave_digest_only',
      adminContext: true,
    };
  }
  if (ch.altwire) {
    map[ch.altwire] = {
      name: 'altwire',
      purpose: 'AltWire music publication operations. Derek\'s primary channel.',
      halRole: 'interactive',
      adminContext: true,
      agentContext: 'altwire',
    };
  }
  if (ch.watercooler) {
    map[ch.watercooler] = {
      name: 'watercooler',
      purpose: 'General team chat. Hal responds if mentioned but never initiates here.',
      halRole: 'passive',
      adminContext: false,
    };
  }

  return map[channelId] || {
    name: 'unknown',
    purpose: 'Unknown channel.',
    halRole: 'interactive',
    adminContext: false,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for testing
// ---------------------------------------------------------------------------

/**
 * Convert standard Markdown to Slack mrkdwn format.
 * - **bold** → *bold*
 * - [text](url) → <url|text>
 * - Preserves fenced code blocks unchanged
 * - Preserves _italic_ unchanged (same syntax)
 *
 * @param {string} markdown
 * @returns {string}
 */
export function formatForSlack(markdown) {
  if (!markdown) return '';
  const parts = [];
  let remaining = markdown;
  while (remaining.length > 0) {
    const codeStart = remaining.indexOf('```');
    if (codeStart === -1) {
      parts.push(convertInlineMarkdown(remaining));
      break;
    }
    if (codeStart > 0) {
      parts.push(convertInlineMarkdown(remaining.slice(0, codeStart)));
    }
    const codeEnd = remaining.indexOf('```', codeStart + 3);
    if (codeEnd === -1) {
      parts.push(remaining.slice(codeStart));
      break;
    }
    parts.push(remaining.slice(codeStart, codeEnd + 3));
    remaining = remaining.slice(codeEnd + 3);
  }
  return parts.join('');
}

function convertInlineMarkdown(text) {
  let result = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
  return result;
}

/**
 * Split a message into chunks that fit within Slack's character limit.
 * Tries to split at newlines when possible.
 *
 * @param {string} text
 * @param {number} [limit=4000]
 * @returns {string[]}
 */
export function splitMessage(text, limit = 4000) {
  if (!text || text.length <= limit) return [text || ''];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitIdx = remaining.lastIndexOf('\n', limit);
    if (splitIdx <= 0 || splitIdx < limit * 0.5) {
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx <= 0) {
      splitIdx = limit;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

/**
 * Strip <@BOT_ID> mention tokens from message text.
 *
 * @param {string} text
 * @param {string} botUserId
 * @returns {string}
 */
export function stripMentions(text, botUserId) {
  if (!text) return '';
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`<@${escaped}>`, 'g'), '').trim();
}

// ---------------------------------------------------------------------------
// Slack request verification
// ---------------------------------------------------------------------------

function verifySlackSignature(body, timestamp, signature) {
  if (!signingSecret || !timestamp || !signature) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;
  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(signature),
  );
}

// ---------------------------------------------------------------------------
// Loop prevention
// ---------------------------------------------------------------------------

export function shouldIgnoreEvent(event) {
  if (event.bot_id && event.bot_id === halBotId) return true;
  if (event.subtype === 'bot_message') return true;
  if (event.user === halBotUserId) return true;
  return false;
}

// ---------------------------------------------------------------------------
// HTTP request handler — for /slack/events endpoint
// ---------------------------------------------------------------------------

export function handleSlackRequest(req, res) {
  const MAX_BODY_BYTES = 262144;
  let bodySize = 0;
  let bodySizeExceeded = false;
  let rawBody = '';

  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_BYTES) {
      bodySizeExceeded = true;
      req.destroy();
      return;
    }
    rawBody += chunk;
  });

  req.on('end', async () => {
    if (bodySizeExceeded) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return;
    }

    let payload;
    const contentType = req.headers['content-type'] || '';
    try {
      if (contentType.includes('application/x-www-form-urlencoded')) {
        payload = Object.fromEntries(new URLSearchParams(rawBody));
      } else {
        payload = JSON.parse(rawBody);
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Malformed payload' }));
      return;
    }

    if (payload.type === 'url_verification') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ challenge: payload.challenge }));
      return;
    }

    if (!slackApp) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Slack integration not initialized' }));
      return;
    }

    const timestamp = req.headers['x-slack-request-timestamp'];
    const slackSignature = req.headers['x-slack-signature'];

    if (!verifySlackSignature(rawBody, timestamp, slackSignature)) {
      logger.warn('slack-altus: invalid signature');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return;
    }

    // Acknowledge immediately — Slack requires 200 within 3 seconds
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    if (payload.type === 'event_callback' && payload.event) {
      await dispatchSlackEvent(payload.event);
    } else if (payload.command === '/hal') {
      await handleSlashCommand(payload);
    }
  });
}

// ---------------------------------------------------------------------------
// Event dispatcher
// ---------------------------------------------------------------------------

export async function dispatchSlackEvent(event) {
  if (!event) return;
  if (shouldIgnoreEvent(event)) {
    logger.debug('slack-altus: ignoring self/bot event', { user: event.user, bot_id: event.bot_id });
    return;
  }
  if (event.type === 'app_mention') {
    await handleMention(event);
  } else if (event.type === 'message') {
    if (event.channel_type === 'im') {
      await handleDirectMessage(event);
    } else if (event.thread_ts && event.thread_ts !== event.ts) {
      await handleThreadReply(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleMention(event) {
  const channelCtx = getChannelContext(event.channel);
  const messageText = stripMentions(event.text, halBotUserId);
  if (!messageText) return;
  const threadTs = event.thread_ts || event.ts;
  let history = [];
  if (event.thread_ts) {
    history = await fetchThreadHistory(event.channel, event.thread_ts);
  }
  // Route to nimbus for AltWire channel; just log for other channels for now
  if (channelCtx.agentContext === 'altwire') {
    await routeToNimbus({
      message: messageText,
      history,
      channel: event.channel,
      threadTs,
      isDm: false,
      slackUserId: event.user,
      agentContext: 'altwire',
    });
  } else {
    logger.debug('slack-altus: mention in non-altwire channel, ignoring', { channel: event.channel });
  }
}

async function handleDirectMessage(event) {
  if (event.subtype) return;
  const messageText = event.text || '';
  if (!messageText) return;
  const history = await fetchDmHistory(event.channel);
  await routeToNimbus({
    message: messageText,
    history,
    channel: event.channel,
    threadTs: event.ts,
    isDm: true,
    slackUserId: event.user,
    agentContext: null,
  });
}

async function handleThreadReply(event) {
  const threadMessages = await fetchThreadHistory(event.channel, event.thread_ts);
  const halInThread = threadMessages.some(msg => msg.role === 'assistant');
  if (!halInThread) {
    const isStatusPost = await checkStatusPost(event.channel, event.thread_ts);
    if (!isStatusPost) return;
    const alreadyProcessed = await checkAndMarkReply(event.channel, event.thread_ts, event.ts);
    if (alreadyProcessed) {
      logger.debug('slack-altus: skipping already-processed status post reply', { ts: event.ts });
      return;
    }
  }
  const channelCtx = getChannelContext(event.channel);
  if (channelCtx.agentContext === 'altwire') {
    await routeToNimbus({
      message: event.text || '',
      history: threadMessages,
      channel: event.channel,
      threadTs: event.thread_ts,
      isDm: false,
      slackUserId: event.user,
      agentContext: 'altwire',
    });
  } else {
    logger.debug('slack-altus: thread reply in non-altwire channel, ignoring', { channel: event.channel });
  }
}

async function handleSlashCommand(payload) {
  const { text, user_id, channel_id, response_url, thread_ts } = payload;
  if (!text || !text.trim()) {
    await postEphemeral(channel_id, user_id, 'Usage: `/hal <your question>` — Ask Hal anything about AltWire operations.');
    return;
  }
  const channelCtx = getChannelContext(channel_id);
  await routeToNimbus({
    message: text.trim(),
    history: [],
    channel: channel_id,
    threadTs: thread_ts || null,
    isDm: false,
    slackUserId: user_id,
    agentContext: channelCtx.agentContext || null,
    ephemeral: !thread_ts,
    responseUrl: response_url,
  });
}

// ---------------------------------------------------------------------------
// Route inbound Slack events to nimbus for processing
// ---------------------------------------------------------------------------

async function routeToNimbus({ message, history, channel, threadTs, isDm, slackUserId, agentContext, ephemeral = false, responseUrl = null }) {
  const nimbusUrl = process.env.NIMBUS_SLACK_WEBHOOK_URL;
  if (!nimbusUrl) {
    logger.warn('slack-altus: NIMBUS_SLACK_WEBHOOK_URL not set — cannot route to nimbus');
    return;
  }

  const channelCtx = getChannelContext(channel);
  const payload = {
    message,
    history,
    channel,
    threadTs,
    isDm,
    slackUserId,
    agentContext: agentContext || channelCtx.agentContext || null,
    ephemeral,
    responseUrl,
    channelName: channelCtx.name,
  };

  try {
    const nimbusRes = await fetch(nimbusUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!nimbusRes.ok) {
      logger.error('slack-altus: nimbus routing failed', { status: nimbusRes.status });
    }
  } catch (err) {
    logger.error('slack-altus: nimbus routing failed', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Slack API helpers
// ---------------------------------------------------------------------------

async function postToThread(channel, threadTs, text) {
  if (!slackApp) return;
  await slackApp.client.chat.postMessage({ channel, thread_ts: threadTs, text });
}

async function postEphemeral(channel, user, text) {
  if (!slackApp) return;
  await slackApp.client.chat.postEphemeral({ channel, user, text });
}

async function fetchThreadHistory(channel, threadTs) {
  if (!slackApp) return [];
  try {
    const result = await slackApp.client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    return buildHistory(result.messages || []);
  } catch (err) {
    logger.error('slack-altus: thread history fetch failed', { error: err.message, channel, threadTs });
    return [];
  }
}

async function fetchDmHistory(channel) {
  if (!slackApp) return [];
  try {
    const result = await slackApp.client.conversations.history({ channel, limit: 20 });
    return buildHistory((result.messages || []).reverse());
  } catch (err) {
    logger.error('slack-altus: DM history fetch failed', { error: err.message, channel });
    return [];
  }
}

function buildHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(msg => {
      if (msg.subtype === 'bot_message' && msg.bot_id) {
        return msg.user === halBotUserId;
      }
      return true;
    })
    .map(msg => ({
      role: msg.user === halBotUserId ? 'assistant' : 'user',
      content: msg.text || '',
    }));
}

async function checkStatusPost(channelId, messageTs) {
  try {
    const { pool } = await import('../lib/altus-db.js');
    const { rows } = await pool.query(
      'SELECT id FROM hal_slack_posts WHERE channel_id = $1 AND message_ts = $2',
      [channelId, messageTs],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function checkAndMarkReply(channelId, messageTs, replyTs) {
  try {
    const { pool } = await import('../lib/altus-db.js');
    const { rowCount } = await pool.query(
      `UPDATE hal_slack_posts
       SET processed_reply_ts = array_append(processed_reply_ts, $1)
       WHERE channel_id = $2 AND message_ts = $3
         AND NOT ($1 = ANY(processed_reply_ts))`,
      [replyTs, channelId, messageTs],
    );
    return rowCount === 0;
  } catch (err) {
    logger.error('slack-altus: reply dedup check failed', { error: err.message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Status posting
// ---------------------------------------------------------------------------

export async function postStatusUpdate({ text, post_type = 'status_update', emoji = ':information_source:', severity = 'normal', channel_override = null, metadata = null }) {
  if (!slackApp) {
    return { posted: false, reason: 'slack_not_initialized' };
  }

  const channels = getChannels();
  let targetChannel = channel_override;

  if (!targetChannel) {
    switch (post_type) {
      case 'dave_digest':
        targetChannel = channels.bugReports;
        break;
      case 'status_update':
      case 'alert':
      case 'incident_resolved':
      case 'task_complete':
      case 'observation':
      default:
        targetChannel = channels.adminAnnouncements;
        break;
    }
  }

  if (!targetChannel) {
    logger.warn(`slack-altus: no channel ID configured for post_type: ${post_type}. Check env vars.`);
    return { posted: false, reason: 'channel_not_configured' };
  }

  try {
    const result = await slackApp.client.chat.postMessage({
      channel: targetChannel,
      text: `${emoji} ${text}`,
    });
    const ts = result.ts;
    try {
      const { pool } = await import('../lib/altus-db.js');
      await pool.query(
        `INSERT INTO hal_slack_posts (channel_id, message_ts, severity, message_text, metadata)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, message_ts) DO NOTHING`,
        [targetChannel, ts, severity, text, metadata ? JSON.stringify(metadata) : null],
      );
    } catch (dbErr) {
      logger.error('slack-altus: failed to record status post', { error: dbErr.message });
    }
    return { posted: true, ts, channel: targetChannel };
  } catch (err) {
    logger.error('slack-altus: status post failed', { error: err.message });
    return { posted: false, reason: 'slack_api_error' };
  }
}

// ---------------------------------------------------------------------------
// Post history query
// ---------------------------------------------------------------------------

export async function getSlackPostHistory({ limit = 10, severity_filter = null } = {}) {
  const { pool } = await import('../lib/altus-db.js');
  const effectiveLimit = Math.min(Math.max(limit, 1), 50);
  let query = 'SELECT * FROM hal_slack_posts';
  const params = [];
  if (severity_filter) {
    query += ' WHERE severity = $1';
    params.push(severity_filter);
  }
  query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
  params.push(effectiveLimit);
  const { rows } = await pool.query(query, params);
  return rows;
}

// ---------------------------------------------------------------------------
// Schema init
// ---------------------------------------------------------------------------

export async function initSlackAltusSchema() {
  const { pool } = await import('../lib/altus-db.js');
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS hal_slack_posts (
        id                 SERIAL PRIMARY KEY,
        channel_id         VARCHAR(255) NOT NULL,
        message_ts         VARCHAR(255) NOT NULL,
        severity           VARCHAR(20)  NOT NULL DEFAULT 'normal',
        message_text       TEXT,
        processed_reply_ts TEXT[]       NOT NULL DEFAULT '{}',
        metadata           JSONB,
        created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_hal_slack_posts_channel_ts
        ON hal_slack_posts(channel_id, message_ts);
    `);
    logger.info('slack-altus: schema initialized');
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initSlackAltus() {
  const token = process.env.SLACK_BOT_TOKEN_ALTUS;
  const secret = process.env.SLACK_SIGNING_SECRET_ALTUS;

  if (!token || !secret) {
    logger.warn('slack-altus: SLACK_BOT_TOKEN_ALTUS or SLACK_SIGNING_SECRET_ALTUS not set — skipping Slack init');
    return;
  }

  signingSecret = secret;

  try {
    const boltModule = await import('@slack/bolt');
    const App = boltModule.App ?? boltModule.default?.App;
    if (!App) {
      logger.error('slack-altus: @slack/bolt App export not found');
      return;
    }

    const noopReceiver = {
      init: () => {},
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };

    slackApp = new App({
      token,
      signingSecret: secret,
      receiver: noopReceiver,
    });

    const authResult = await slackApp.client.auth.test({ token });
    halBotUserId = authResult.user_id;
    halBotId = authResult.bot_id;

    logger.info('slack-altus: initialized', { botUserId: halBotUserId, botId: halBotId });
  } catch (err) {
    logger.error('slack-altus: initialization failed', { error: err.message });
    slackApp = null;
    halBotUserId = null;
    halBotId = null;
  }
}
