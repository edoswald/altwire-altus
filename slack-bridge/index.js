/**
 * AltWire Insights Slack bridge.
 *
 * Slack (Events API) ──► this service ──► Claude Managed Agents session ──► Slack reply
 *
 * - @mention in an allowlisted channel → one agent session per Slack thread
 * - DM → personal conversation; the person's own vault (mail, Canva) is
 *   attached only here, never in channels
 * - DM commands: connect <canva | MCP URL>, connections, new, help
 * - Scheduled jobs (BRIDGE_SCHEDULES) run fresh sessions and post to their channel
 *
 * The agent has no Slack tools: the bridge posts every reply itself and only
 * to DMs or BRIDGE_ALLOWED_CHANNELS.
 */

import { createServer } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import pg from 'pg';

import { SlackClient } from './lib/slack.js';
import { parseCsvSet } from './lib/router.js';
import { Store } from './lib/store.js';
import { parseSchedules } from './lib/schedules.js';
import { createBridge } from './lib/app.js';

const log = {
  info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', msg, ...meta })),
  warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'warn', msg, ...meta })),
  error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'error', msg, ...meta })),
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const env = process.env;
const config = {
  port: Number(env.PORT || 3000),
  publicUrl: (env.BRIDGE_PUBLIC_URL || '').replace(/\/+$/, ''),
  agentId: env.BRIDGE_AGENT_ID,
  environmentId: env.BRIDGE_ENVIRONMENT_ID,
  sharedVaultId: env.BRIDGE_SHARED_VAULT_ID || null,
  slackToken: env.SLACK_BOT_TOKEN,
  slackSigningSecret: env.SLACK_SIGNING_SECRET,
  allowedChannels: parseCsvSet(env.BRIDGE_ALLOWED_CHANNELS),
  connectUsers: parseCsvSet(env.BRIDGE_CONNECT_USERS),
  dmSessionIdleMinutes: Number(env.BRIDGE_DM_SESSION_IDLE_MINUTES || 120),
  databaseUrl: env.BRIDGE_DATABASE_URL || env.DATABASE_URL,
};

const missing = ['agentId', 'environmentId', 'slackToken', 'slackSigningSecret', 'databaseUrl', 'publicUrl']
  .filter((k) => !config[k]);
if (missing.length) {
  log.error('Missing required configuration', { missing });
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: false }, max: 5 });
const store = new Store(pool);
const slack = new SlackClient({ token: config.slackToken });
const bridge = createBridge({ config, store, anthropic: new Anthropic(), slack, log });

await store.init();
const botUserId = (await slack.authTest()).user_id;
bridge.setBotUserId(botUserId);

const { jobs, errors } = parseSchedules(env.BRIDGE_SCHEDULES, { allowedChannels: config.allowedChannels });
for (const e of errors) log.error('Invalid schedule', { error: e });
for (const job of jobs) {
  if (!cron.validate(job.cron)) {
    log.error('Invalid schedule', { error: `schedule ${job.name}: invalid cron "${job.cron}"` });
    continue;
  }
  cron.schedule(job.cron, () => bridge.runScheduledJob(job), { timezone: job.timezone, name: job.name, noOverlap: true });
}
cron.schedule('17 * * * *', () => store.pruneSeenEvents().catch(() => {}), { name: 'prune' });

createServer((req, res) => bridge.handleHttp(req, res)).listen(config.port, () => {
  log.info('Slack bridge listening', {
    port: config.port,
    botUserId,
    allowedChannels: [...config.allowedChannels],
    schedules: jobs.map((j) => `${j.name} (${j.cron} ${j.timezone})`),
  });
});
