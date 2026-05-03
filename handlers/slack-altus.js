/**
 * handlers/slack-altus.js — Slack integration for Altus MCP server.
 *
 * Provides:
 *   postStatusUpdate(...)     — Hal-initiated status posts with channel routing
 *   getSlackPostHistory(...)  — Query recent Hal-initiated Slack posts
 *   initSlackAltusSchema()    — Create hal_slack_posts table
 *
 * Uses @slack/bolt with receiver: false and manual request processing.
 * Does NOT bridge Slack events into runSession — that requires hal-harness.js
 * which is nimbus-specific. Here we only provide outbound status posting.
 *
 * Exports:
 *   initSlackAltus()            — startup init (creates Bolt app, stores bot user ID)
 *   handleSlackRequest(req, res) — raw HTTP handler for /slack/events
 *   postStatusUpdate(...)       — post a status update to a Slack channel
 *   getSlackPostHistory(...)     — query recent posts from hal_slack_posts
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

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    if (payload.type === 'event_callback' && payload.event) {
      // For now, log and ignore events — the full event handling
      // (mentions, DMs, thread replies) requires hal-harness.js runSession
      // which is nimbus-specific. This handler just handles outbound posts.
      logger.debug('slack-altus: received event', { type: payload.event.type });
    }
  });
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

    // Record in hal_slack_posts
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