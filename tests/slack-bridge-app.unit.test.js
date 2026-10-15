import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createBridge } from '../slack-bridge/lib/app.js';

const TEAM = 'C0AVAMXP17Y';
const HOLIDAY = 'C0C8DSN1BP0';
const BOT = 'UBOT';
const DEREK = 'UDEREK';
const SECRET = 'signing-secret';

// ---------------------------------------------------------------- fakes
class MemoryStore {
  constructor() {
    this.sessions = new Map();
    this.vaults = new Map();
    this.states = new Map();
    this.seen = new Set();
  }
  async markEventSeen(id) { if (this.seen.has(id)) return false; this.seen.add(id); return true; }
  async getSession(key) { return this.sessions.get(key) ?? null; }
  async saveSession(key, s) { this.sessions.set(key, { ...s }); }
  async touchSession() {}
  async forgetSession(key) { this.sessions.delete(key); }
  async forgetDmSessions(user) { for (const [k, s] of this.sessions) if (s.slackUserId === user && k.startsWith('D')) this.sessions.delete(k); }
  async getUserVault(user) { return this.vaults.get(user) ?? null; }
  async saveUserVault(user, id) { this.vaults.set(user, id); }
  async saveOAuthState(state, data) { this.states.set(state, data); }
  async takeOAuthState(state) { const s = this.states.get(state) ?? null; this.states.delete(state); return s; }
  async getSentFiles(sessionId) { return new Set([...(this.sent ??= new Set())].filter((k) => k.startsWith(`${sessionId}:`)).map((k) => k.split(':')[1])); }
  async markFileSent(sessionId, fileId) { (this.sent ??= new Set()).add(`${sessionId}:${fileId}`); }
}

function fakeSlack() {
  const calls = [];
  let n = 0;
  return {
    calls,
    async post(args) { calls.push({ method: 'post', ...args }); n += 1; return { ts: `ts${n}` }; },
    async update(args) { calls.push({ method: 'update', ...args }); return {}; },
    async uploadFile(args) {
      if (args.filename === 'broken.pdf') throw new Error('missing_scope');
      calls.push({ method: 'upload', channel: args.channel, thread_ts: args.thread_ts, filename: args.filename, text: args.bytes.toString() });
      return 'F1';
    },
  };
}

function fakeAnthropic({ replies = ['Traffic is **up** 5%.'], failFirstSend = false, credentials = {}, sessionFiles = {} } = {}) {
  const log = { sessions: [], sent: [], vaults: [], creds: [], archived: [] };
  let replyIndex = 0;
  let failed = false;
  const asyncIter = (items) => ({ async *[Symbol.asyncIterator]() { yield* items; } });
  return {
    log,
    credentials,
    beta: {
      files: {
        list: ({ scope_id: scopeId }) => asyncIter(sessionFiles[scopeId] ?? []),
        download: async (id) => ({ arrayBuffer: async () => new TextEncoder().encode(`bytes of ${id}`).buffer }),
      },
      agents: {
        retrieve: async (id) => ({ id, version: 4, mcp_servers: [{ type: 'url', name: 'altus', url: 'https://altus.example/' }], tools: [{ type: 'mcp_toolset', mcp_server_name: 'altus' }] }),
      },
      sessions: {
        create: async (params) => { log.sessions.push(params); return { id: `sesn_${log.sessions.length}` }; },
        events: {
          stream: async () => {
            const text = replies[Math.min(replyIndex, replies.length - 1)];
            replyIndex += 1;
            return asyncIter([
              { type: 'agent.message', content: [{ type: 'text', text }] },
              { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
            ]);
          },
          send: async (sessionId, body) => {
            if (failFirstSend && !failed) { failed = true; throw new Error('session archived'); }
            log.sent.push({ sessionId, ...body.events[0] });
          },
        },
      },
      vaults: {
        create: async (params) => { log.vaults.push(params); return { id: 'vlt_derek' }; },
        credentials: {
          list: (vaultId) => asyncIter(credentials[vaultId] ?? []),
          create: async (vaultId, params) => { log.creds.push({ vaultId, ...params }); return { id: 'vcrd_1' }; },
          archive: async (id, params) => { log.archived.push({ id, ...params }); return {}; },
        },
      },
    },
  };
}

function makeBridge(overrides = {}) {
  const store = overrides.store ?? new MemoryStore();
  const slack = fakeSlack();
  const anthropic = overrides.anthropic ?? fakeAnthropic();
  const bridge = createBridge({
    config: {
      publicUrl: 'https://bridge.example',
      agentId: 'agent_1',
      environmentId: 'env_1',
      sharedVaultId: 'vlt_shared',
      slackSigningSecret: SECRET,
      allowedChannels: new Set([TEAM]),
      connectUsers: new Set([DEREK]),
      dmSessionIdleMinutes: 120,
      botUserId: BOT,
      ...overrides.config,
    },
    store,
    anthropic,
    slack,
    log: { info() {}, warn() {}, error() {} },
    fetchImpl: overrides.fetchImpl,
    sleep: async () => {},
  });
  return { bridge, store, slack, anthropic };
}

let eventCounter = 0;
const envelope = (event) => ({ type: 'event_callback', event_id: `Ev${++eventCounter}`, event });
const mention = (text, extra = {}) => envelope({ type: 'app_mention', user: 'U1', channel: TEAM, ts: '100.1', text: `<@${BOT}> ${text}`, ...extra });
const dm = (text, user = DEREK) => envelope({ type: 'message', channel_type: 'im', user, channel: 'D1', ts: '200.1', text });

async function deliver(bridge, env) {
  await bridge.handleSlackEvent(env);
  await bridge.idle();
}

function request({ method = 'POST', url, body = '', headers = {} }) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(req, { method, url, headers });
  return req;
}

function response() {
  const res = { status: null, headers: {}, body: '', headersSent: false };
  res.writeHead = (status, headers = {}) => { res.status = status; res.headers = headers; res.headersSent = true; return res; };
  res.end = (body = '') => { res.body += body; return res; };
  return res;
}

function signed(body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${crypto.createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig };
}

// ---------------------------------------------------------------- tests
describe('conversations', () => {
  it('answers a channel mention in a thread with the shared vault only', async () => {
    const { bridge, slack, anthropic, store } = makeBridge();
    await deliver(bridge, mention('how are we doing?'));

    expect(slack.calls[0]).toMatchObject({ method: 'post', channel: TEAM, thread_ts: '100.1', text: '_Working on it…_' });
    expect(anthropic.log.sessions[0]).toMatchObject({ agent: 'agent_1', environment_id: 'env_1', vault_ids: ['vlt_shared'] });
    expect(anthropic.log.sent[0]).toMatchObject({ type: 'user.message', content: [{ type: 'text', text: 'how are we doing?' }] });
    expect(slack.calls[1]).toEqual({ method: 'update', channel: TEAM, ts: 'ts1', text: 'Traffic is *up* 5%.' });
    expect(store.sessions.get(`${TEAM}:100.1`).sessionId).toBe('sesn_1');
  });

  it('ignores channels that are not allowlisted, duplicate events, and empty mentions', async () => {
    const { bridge, slack } = makeBridge();
    await deliver(bridge, mention('hi', { channel: HOLIDAY }));
    const env = mention('hi');
    await deliver(bridge, env);
    await deliver(bridge, env);
    await deliver(bridge, mention('   ', { ts: '300.1' }));
    expect(slack.calls.filter((c) => c.method === 'post')).toHaveLength(1);
  });

  it('continues a thread only if it already has a session', async () => {
    const { bridge, anthropic, slack } = makeBridge();
    const followup = (ts) => envelope({ type: 'message', channel_type: 'channel', user: 'U2', channel: TEAM, ts: '101.0', thread_ts: ts, text: 'and last month?' });
    await deliver(bridge, followup('999.9'));
    expect(slack.calls).toHaveLength(0);

    await deliver(bridge, mention('how are we doing?'));
    await deliver(bridge, followup('100.1'));
    expect(anthropic.log.sessions).toHaveLength(1);
    expect(anthropic.log.sent.map((e) => e.sessionId)).toEqual(['sesn_1', 'sesn_1']);
  });

  it('starts a fresh session once when the old one is unusable', async () => {
    const { bridge, anthropic, slack } = makeBridge({ anthropic: fakeAnthropic({ failFirstSend: true }) });
    await deliver(bridge, mention('hello'));
    expect(anthropic.log.sessions).toHaveLength(2);
    expect(slack.calls.at(-1)).toMatchObject({ method: 'update', text: 'Traffic is *up* 5%.' });
  });
});

describe('DMs and personal accounts', () => {
  it('adds the person\'s vault and linked servers only in their DM', async () => {
    const store = new MemoryStore();
    store.vaults.set(DEREK, 'vlt_derek');
    const anthropic = fakeAnthropic({ credentials: { vlt_derek: [{ display_name: 'Canva', auth: { mcp_server_url: 'https://mcp.canva.com/mcp' }, archived_at: null }] } });
    const { bridge } = makeBridge({ store, anthropic });

    await deliver(bridge, dm('any new Canva templates?'));
    const created = anthropic.log.sessions[0];
    expect(created.vault_ids).toEqual(['vlt_shared', 'vlt_derek']);
    expect(created.agent).toMatchObject({ type: 'agent_with_overrides', id: 'agent_1' });
    expect(created.agent.mcp_servers.map((s) => s.name)).toEqual(['altus', 'personal_canva']);

    await deliver(bridge, mention('how are we doing?', { user: DEREK }));
    expect(anthropic.log.sessions[1]).toMatchObject({ agent: 'agent_1', vault_ids: ['vlt_shared'] });
  });

  it('handles DM commands without calling the agent', async () => {
    const { bridge, slack, anthropic, store } = makeBridge();
    store.sessions.set('D1:dm', { sessionId: 'sesn_old', slackUserId: DEREK, vaultIds: [] });
    await deliver(bridge, dm('new'));
    await deliver(bridge, dm('help'));
    await deliver(bridge, dm('connections'));
    expect(store.sessions.has('D1:dm')).toBe(false);
    expect(slack.calls.map((c) => c.text)).toEqual([
      'Started fresh. What would you like to know?',
      expect.stringContaining('connect canva'),
      'You have no linked accounts yet. Try `connect canva`.',
    ]);
    expect(anthropic.log.sessions).toHaveLength(0);
  });

  it('refuses linking for people not on the list and explains Gmail', async () => {
    const { bridge, slack } = makeBridge();
    await deliver(bridge, dm('connect canva', 'U_OTHER'));
    await deliver(bridge, dm('connect gmail'));
    expect(slack.calls[0].text).toMatch(/not enabled for you/);
    expect(slack.calls[1].text).toMatch(/Gmail has no public MCP server/);
  });

  it('links Canva end to end: sign-in link, callback, vault credential, fresh DM session', async () => {
    const tokenCalls = [];
    const fetchImpl = async (url, init = {}) => {
      const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
      if (url === 'https://mcp.canva.com/.well-known/oauth-protected-resource/mcp') {
        return json(200, { resource: 'https://mcp.canva.com/mcp', authorization_servers: ['https://mcp.canva.com'], scopes_supported: ['design:meta:read'] });
      }
      if (url === 'https://mcp.canva.com/.well-known/oauth-authorization-server') {
        return json(200, { authorization_endpoint: 'https://mcp.canva.com/authorize', token_endpoint: 'https://mcp.canva.com/token', registration_endpoint: 'https://mcp.canva.com/register' });
      }
      if (url === 'https://mcp.canva.com/register') {
        expect(JSON.parse(init.body).redirect_uris).toEqual(['https://bridge.example/oauth/callback']);
        return json(201, { client_id: 'dyn_client' });
      }
      if (url === 'https://mcp.canva.com/token') {
        tokenCalls.push(new URLSearchParams(init.body));
        return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
      }
      return json(404, {});
    };
    const { bridge, slack, anthropic, store } = makeBridge({ fetchImpl });
    store.sessions.set('D1:dm', { sessionId: 'sesn_old', slackUserId: DEREK, vaultIds: [] });

    await deliver(bridge, dm('connect canva'));
    const linkText = slack.calls[0].text;
    const link = new URL(linkText.match(/<(https:[^|>]+)\|/)[1]);
    expect(link.origin + link.pathname).toBe('https://mcp.canva.com/authorize');
    expect(link.searchParams.get('code_challenge_method')).toBe('S256');
    const state = link.searchParams.get('state');

    const res = response();
    await bridge.handleHttp(request({ method: 'GET', url: `/oauth/callback?code=abc&state=${state}` }), res);
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/Canva is linked/);
    expect(tokenCalls[0].get('code')).toBe('abc');
    expect(tokenCalls[0].get('code_verifier')).toBeTruthy();

    expect(anthropic.log.vaults).toHaveLength(1);
    expect(store.vaults.get(DEREK)).toBe('vlt_derek');
    expect(anthropic.log.creds[0]).toMatchObject({
      vaultId: 'vlt_derek',
      display_name: 'Canva',
      auth: { type: 'mcp_oauth', mcp_server_url: 'https://mcp.canva.com/mcp', access_token: 'at', refresh: { client_id: 'dyn_client', token_endpoint: 'https://mcp.canva.com/token' } },
    });
    expect(store.sessions.has('D1:dm')).toBe(false);
    expect(slack.calls.at(-1)).toMatchObject({ channel: 'D1', text: expect.stringMatching(/Canva is linked/) });

    // The link works once.
    const again = response();
    await bridge.handleHttp(request({ method: 'GET', url: `/oauth/callback?code=abc&state=${state}` }), again);
    expect(again.status).toBe(400);
  });
});

describe('HTTP', () => {
  it('rejects unsigned Slack requests and answers URL verification', async () => {
    const { bridge } = makeBridge();
    const bad = response();
    await bridge.handleHttp(request({ url: '/slack/events', body: '{}', headers: { 'x-slack-signature': 'v0=nope', 'x-slack-request-timestamp': '1' } }), bad);
    expect(bad.status).toBe(401);

    const body = JSON.stringify({ type: 'url_verification', challenge: 'xyz' });
    const ok = response();
    await bridge.handleHttp(request({ url: '/slack/events', body, headers: signed(body) }), ok);
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('xyz');

    const health = response();
    await bridge.handleHttp(request({ method: 'GET', url: '/health' }), health);
    expect(JSON.parse(health.body).status).toBe('ok');
  });
});

describe('scheduled jobs', () => {
  it('posts a finished run to its channel with a fresh, shared-vault session', async () => {
    const { bridge, slack, anthropic } = makeBridge();
    await bridge.runScheduledJob({ name: 'weekly-recap', channel: TEAM, prompt: 'Recap the week.', timezone: 'America/New_York' });
    expect(anthropic.log.sessions[0]).toMatchObject({ agent: 'agent_1', vault_ids: ['vlt_shared'], title: 'Scheduled: weekly-recap' });
    expect(anthropic.log.sent[0].content[0].text).toMatch(/^Recap the week\./);
    expect(slack.calls).toEqual([{ method: 'post', channel: TEAM, text: 'Traffic is *up* 5%.', thread_ts: undefined }]);
  });
});

describe('file attachments', () => {
  const report = { id: 'file_1', filename: 'top-pages.xlsx', size_bytes: 2048, created_at: '2026-10-14T20:00:00Z', downloadable: true };

  it('attaches files the agent created to the thread, once', async () => {
    const anthropic = fakeAnthropic({ sessionFiles: { sesn_1: [report] } });
    const { bridge, slack } = makeBridge({ anthropic });
    await deliver(bridge, mention('spreadsheet of top pages please'));
    expect(slack.calls.filter((c) => c.method === 'upload')).toEqual([
      { method: 'upload', channel: TEAM, thread_ts: '100.1', filename: 'top-pages.xlsx', text: 'bytes of file_1' },
    ]);
    await deliver(bridge, envelope({ type: 'message', channel_type: 'channel', user: 'U2', channel: TEAM, ts: '101.0', thread_ts: '100.1', text: 'thanks' }));
    expect(slack.calls.filter((c) => c.method === 'upload')).toHaveLength(1);
  });

  it('skips oversized and non-downloadable files and reports upload failures', async () => {
    const anthropic = fakeAnthropic({ sessionFiles: { sesn_1: [
      { id: 'file_big', filename: 'huge.zip', size_bytes: 80 * 1024 * 1024, created_at: '1' },
      { id: 'file_hidden', filename: 'input.csv', downloadable: false, created_at: '2' },
      { id: 'file_bad', filename: 'broken.pdf', size_bytes: 10, created_at: '3' },
    ] } });
    const { bridge, slack } = makeBridge({ anthropic });
    await deliver(bridge, mention('make a pdf'));
    expect(slack.calls.filter((c) => c.method === 'upload')).toHaveLength(0);
    expect(slack.calls.at(-1)).toMatchObject({ method: 'post', thread_ts: '100.1', text: "_Couldn't attach broken.pdf: missing_scope_" });
  });

  it('threads a scheduled job\'s files under its post', async () => {
    const anthropic = fakeAnthropic({ sessionFiles: { sesn_1: [report] } });
    const { bridge, slack } = makeBridge({ anthropic });
    await bridge.runScheduledJob({ name: 'weekly-recap', channel: TEAM, prompt: 'Recap.', timezone: 'America/New_York' });
    expect(slack.calls.map((c) => [c.method, c.thread_ts])).toEqual([['post', undefined], ['upload', 'ts1']]);
  });
});

describe('shared memory store', () => {
  const memoryConfig = { memoryStoreId: 'memstore_team', memoryDmAccess: 'read_only' };

  it('mounts the store read-write in channels and scheduled jobs, read-only in DMs', async () => {
    const { bridge, anthropic } = makeBridge({ config: memoryConfig });
    await deliver(bridge, mention('what did we decide about the vinyl guide?'));
    await deliver(bridge, dm('anything new?'));
    await bridge.runScheduledJob({ name: 'holiday-check-in', channel: TEAM, prompt: 'Check in.', timezone: 'America/New_York' });

    const [channel, direct, scheduled] = anthropic.log.sessions.map((s) => s.resources);
    expect(channel).toEqual([expect.objectContaining({ type: 'memory_store', memory_store_id: 'memstore_team', access: 'read_write' })]);
    expect(channel[0].instructions).toMatch(/Never save: anything from someone's email/);
    expect(direct).toEqual([expect.objectContaining({ access: 'read_only' })]);
    expect(direct[0].instructions).toMatch(/read-only in this conversation/);
    expect(scheduled).toEqual([expect.objectContaining({ access: 'read_write' })]);
  });

  it('can make DMs read-write, and sends no resources when no store is configured', async () => {
    const rw = makeBridge({ config: { memoryStoreId: 'memstore_team', memoryDmAccess: 'read_write' } });
    await deliver(rw.bridge, dm('remember that Derek owns the plugin guide'));
    expect(rw.anthropic.log.sessions[0].resources[0].access).toBe('read_write');

    const none = makeBridge();
    await deliver(none.bridge, mention('hi'));
    expect(none.anthropic.log.sessions[0]).not.toHaveProperty('resources');
  });
});

