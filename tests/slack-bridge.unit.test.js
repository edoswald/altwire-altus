import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { chunkText, toSlackMrkdwn, verifySlackSignature } from '../slack-bridge/lib/slack.js';
import { canPostIn, parseCommand, parseCsvSet, routeEvent, vaultsFor } from '../slack-bridge/lib/router.js';
import { replyText, runTurn } from '../slack-bridge/lib/agent-session.js';
import {
  buildAuthorizeUrl, buildVaultAuth, discover, exchangeCode, normalizeServerUrl, registerClient, resolveServer,
} from '../slack-bridge/lib/mcp-oauth.js';
import { parseSchedules, scheduledPrompt } from '../slack-bridge/lib/schedules.js';
import { HOLIDAY_TRACKER_PATH, MEMORY_SEEDS, memoryResourcesFor, parseDmAccess, seedMemoryStore } from '../slack-bridge/lib/memory.js';

const BOT = 'UBOT';

describe('verifySlackSignature', () => {
  const secret = 'shh';
  const body = '{"type":"event_callback"}';
  const now = 1_760_000_000_000;
  const ts = String(now / 1000);
  const sig = `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;

  it('accepts a valid signature and rejects tampering, stale timestamps, and missing parts', () => {
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sig, body, now })).toBe(true);
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sig, body: `${body} `, now })).toBe(false);
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sig, body, now: now + 10 * 60_000 })).toBe(false);
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: 'v0=short', body, now })).toBe(false);
    expect(verifySlackSignature({ signingSecret: '', timestamp: ts, signature: sig, body, now })).toBe(false);
  });
});

describe('toSlackMrkdwn and chunkText', () => {
  it('converts headings, bold, links, and bullets but leaves code blocks alone', () => {
    const md = '## Top **stories**\n- **Bold** item\n* other\n[AltWire](https://altwire.net)\n```\n**not bold**\n```';
    expect(toSlackMrkdwn(md)).toBe('*Top stories*\n• *Bold* item\n• other\n<https://altwire.net|AltWire>\n```\n**not bold**\n```');
  });

  it('renders Markdown tables as aligned monospace blocks and leaves pipes in prose alone', () => {
    const md = 'Numbers\n| Metric | This week | Change |\n|---|:---:|---:|\n| Visits | 2,433 | **−23.2%** |\n| Clicks | 243 | −19.5% |\nDone | ok';
    expect(toSlackMrkdwn(md)).toBe([
      'Numbers',
      '```',
      'Metric  This week  Change',
      '------  ---------  ------',
      'Visits  2,433      −23.2%',
      'Clicks  243        −19.5%',
      '```',
      'Done | ok',
    ].join('\n'));
    expect(toSlackMrkdwn('| not a table |')).toBe('| not a table |');
  });

  it('splits long text on paragraph breaks', () => {
    const para = 'x'.repeat(60);
    const chunks = chunkText([para, para, para].join('\n\n'), 130);
    expect(chunks).toEqual([`${para}\n\n${para}`, para]);
    expect(chunkText('')).toEqual(['']);
  });
});

describe('routeEvent', () => {
  it('routes a channel mention to a per-thread session', () => {
    const r = routeEvent({ type: 'app_mention', user: 'U1', channel: 'C1', ts: '100.1', text: `<@${BOT}> how are we doing?` }, { botUserId: BOT });
    expect(r).toMatchObject({ kind: 'mention', isDm: false, text: 'how are we doing?', sessionKey: 'C1:100.1', replyThreadTs: '100.1' });
    const inThread = routeEvent({ type: 'app_mention', user: 'U1', channel: 'C1', ts: '105.0', thread_ts: '100.1', text: `<@${BOT}> more` }, { botUserId: BOT });
    expect(inThread.sessionKey).toBe('C1:100.1');
  });

  it('routes DMs to a rolling session, threaded DMs to their thread', () => {
    expect(routeEvent({ type: 'message', channel_type: 'im', user: 'U1', channel: 'D1', ts: '1.0', text: 'hi' }, { botUserId: BOT }))
      .toMatchObject({ kind: 'dm', isDm: true, sessionKey: 'D1:dm', rolling: true, replyThreadTs: null });
    expect(routeEvent({ type: 'message', channel_type: 'im', user: 'U1', channel: 'D1', ts: '2.0', thread_ts: '1.5', text: 'hi' }, { botUserId: BOT }))
      .toMatchObject({ sessionKey: 'D1:1.5', rolling: false, replyThreadTs: '1.5' });
  });

  it('treats unmentioned channel thread replies as follow-ups and ignores the rest', () => {
    expect(routeEvent({ type: 'message', channel_type: 'channel', user: 'U1', channel: 'C1', ts: '3.0', thread_ts: '1.0', text: 'and last month?' }, { botUserId: BOT }))
      .toMatchObject({ kind: 'thread_followup', sessionKey: 'C1:1.0' });
    // top-level channel chatter, mentions (handled as app_mention), bots, and edits are ignored
    expect(routeEvent({ type: 'message', channel_type: 'channel', user: 'U1', channel: 'C1', ts: '3.0', text: 'lunch?' }, { botUserId: BOT })).toBeNull();
    expect(routeEvent({ type: 'message', channel_type: 'channel', user: 'U1', channel: 'C1', ts: '3.0', thread_ts: '1.0', text: `<@${BOT}> hi` }, { botUserId: BOT })).toBeNull();
    expect(routeEvent({ type: 'message', channel_type: 'im', bot_id: 'B1', user: 'U9', channel: 'D1', ts: '1', text: 'x' }, { botUserId: BOT })).toBeNull();
    expect(routeEvent({ type: 'message', channel_type: 'im', user: BOT, channel: 'D1', ts: '1', text: 'x' }, { botUserId: BOT })).toBeNull();
    expect(routeEvent({ type: 'message', subtype: 'message_changed', channel_type: 'im', user: 'U1', channel: 'D1', ts: '1', text: 'x' }, { botUserId: BOT })).toBeNull();
  });
});

describe('vaults and posting rules', () => {
  it('attaches a personal vault only in a DM', () => {
    expect(vaultsFor({ isDm: true, user: 'U1', sharedVaultId: 'vlt_s', personalVaultId: 'vlt_p' })).toEqual(['vlt_s', 'vlt_p']);
    expect(vaultsFor({ isDm: false, user: 'U1', sharedVaultId: 'vlt_s', personalVaultId: 'vlt_p' })).toEqual(['vlt_s']);
    expect(vaultsFor({ isDm: true, user: 'U1', sharedVaultId: null, personalVaultId: null })).toEqual([]);
  });

  it('posts only to DMs and allowlisted channels', () => {
    const allowedChannels = parseCsvSet(' C0AVAMXP17Y , ');
    expect(canPostIn('C0AVAMXP17Y', { isDm: false, allowedChannels })).toBe(true);
    expect(canPostIn('C0C8DSN1BP0', { isDm: false, allowedChannels })).toBe(false);
    expect(canPostIn('D123', { isDm: true, allowedChannels })).toBe(true);
  });
});

describe('parseCommand', () => {
  it('recognizes bridge commands and leaves questions alone', () => {
    expect(parseCommand('help')).toEqual({ name: 'help' });
    expect(parseCommand('New')).toEqual({ name: 'new' });
    expect(parseCommand('connect canva')).toEqual({ name: 'connect', arg: 'canva' });
    expect(parseCommand('connect <https://mcp.zoho.com/abc|mcp.zoho.com/abc>')).toEqual({ name: 'connect', arg: 'https://mcp.zoho.com/abc' });
    expect(parseCommand('connect')).toEqual({ name: 'help' });
    expect(parseCommand('new album ideas for next week?')).toBeNull();
    expect(parseCommand('how did we do?')).toBeNull();
  });
});

describe('runTurn', () => {
  function fakeClient(events) {
    const sent = [];
    return {
      sent,
      beta: { sessions: { events: {
        stream: async () => (async function* () { yield* events; })(),
        send: async (_id, body) => { sent.push(...body.events); },
      } } },
    };
  }

  it('returns the last agent message and denies paused tool calls', async () => {
    const client = fakeClient([
      { type: 'agent.message', content: [{ type: 'text', text: 'Checking Altus…' }] },
      { type: 'agent.mcp_tool_use', id: 'sevt_1', evaluated_permission: 'ask' },
      { type: 'session.status_idle', stop_reason: { type: 'requires_action' } },
      { type: 'agent.mcp_tool_use', id: 'sevt_2', evaluated_permission: 'allow' },
      { type: 'agent.message', content: [{ type: 'text', text: 'Traffic is up 5%.' }] },
      { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
      { type: 'agent.message', content: [{ type: 'text', text: 'never read' }] },
    ]);
    const result = await runTurn(client, 'sesn_1', 'How are we doing?');
    expect(result).toEqual({ text: 'Traffic is up 5%.', stopReason: 'end_turn', toolCalls: 2 });
    expect(client.sent[0]).toEqual({ type: 'user.message', content: [{ type: 'text', text: 'How are we doing?' }] });
    expect(client.sent[1]).toMatchObject({ type: 'user.tool_confirmation', tool_use_id: 'sevt_1', result: 'deny' });
    expect(client.sent).toHaveLength(2);
  });

  it('explains endings without a reply', () => {
    expect(replyText([], { stopReason: 'retries_exhausted' })).toMatch(/error/);
    expect(replyText([], { stopReason: 'end_turn' })).toMatch(/without a reply/);
    expect(replyText(['partial'], { stopReason: 'end_turn', timedOut: true })).toMatch(/^partial\n\n_\(Stopped/);
  });
});

describe('MCP OAuth', () => {
  function jsonResponse(status, data) {
    return { ok: status >= 200 && status < 300, status, json: async () => data };
  }

  it('resolves names and URLs, refusing Gmail and plain http', () => {
    expect(resolveServer('Canva')).toEqual({ label: 'Canva', url: 'https://mcp.canva.com/mcp' });
    expect(resolveServer('https://mcp.zoho.com/mcp/abc#x')).toEqual({ label: 'Zoho', url: 'https://mcp.zoho.com/mcp/abc' });
    expect(resolveServer('gmail').error).toMatch(/Gmail/);
    expect(resolveServer('zoho').error).toMatch(/zoho.com\/mcp/);
    expect(resolveServer('http://example.com').error).toMatch(/https/);
    expect(resolveServer('banana').error).toBeTruthy();
  });

  it('discovers via path-inserted protected-resource metadata, then the authorization server', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
        return jsonResponse(200, { resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'], scopes_supported: ['read'] });
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return jsonResponse(200, { authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token', registration_endpoint: 'https://auth.example.com/register' });
      }
      return jsonResponse(404, {});
    });
    await expect(discover('https://mcp.example.com/mcp', { fetchImpl })).resolves.toMatchObject({
      resource: 'https://mcp.example.com/mcp',
      scopes: ['read'],
      tokenEndpoint: 'https://auth.example.com/token',
      registrationEndpoint: 'https://auth.example.com/register',
    });
  });

  it('falls back to the server origin when there is no protected-resource metadata', async () => {
    const fetchImpl = async (url) => (url === 'https://legacy.example.com/.well-known/oauth-authorization-server'
      ? jsonResponse(200, { authorization_endpoint: 'https://legacy.example.com/a', token_endpoint: 'https://legacy.example.com/t' })
      : jsonResponse(404, {}));
    const meta = await discover('https://legacy.example.com/mcp', { fetchImpl });
    expect(meta).toMatchObject({ resource: 'https://legacy.example.com/mcp', registrationEndpoint: null });
    await expect(registerClient(meta.registrationEndpoint, { redirectUri: 'https://b/cb', clientName: 'x', fetchImpl })).rejects.toThrow(/automatic client registration/);
  });

  it('builds an authorize URL with PKCE, resource, and scopes', () => {
    const url = new URL(buildAuthorizeUrl({
      authorizationEndpoint: 'https://auth.example.com/authorize?prompt=consent', clientId: 'c1', redirectUri: 'https://bridge/oauth/callback',
      state: 's1', codeChallenge: 'ch', resource: 'https://mcp.example.com/mcp', scopes: ['a', 'b'],
    }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      prompt: 'consent', response_type: 'code', client_id: 'c1', redirect_uri: 'https://bridge/oauth/callback', state: 's1',
      code_challenge: 'ch', code_challenge_method: 'S256', resource: 'https://mcp.example.com/mcp', scope: 'a b',
    });
  });

  it('exchanges a code with the right client authentication', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push(init); return jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }); };
    await exchangeCode({ tokenEndpoint: 'https://t', code: 'c', redirectUri: 'r', clientId: 'id', clientSecret: 'sec', authMethod: 'client_secret_basic', codeVerifier: 'v', resource: 'res', fetchImpl });
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('id:sec').toString('base64')}`);
    expect(new URLSearchParams(calls[0].body).get('client_secret')).toBeNull();
    await exchangeCode({ tokenEndpoint: 'https://t', code: 'c', redirectUri: 'r', clientId: 'id', clientSecret: 'sec', authMethod: 'client_secret_post', codeVerifier: 'v', fetchImpl });
    expect(new URLSearchParams(calls[1].body).get('client_secret')).toBe('sec');
    const fail = async () => jsonResponse(400, { error: 'invalid_grant' });
    await expect(exchangeCode({ tokenEndpoint: 'https://t', code: 'c', redirectUri: 'r', clientId: 'id', codeVerifier: 'v', fetchImpl: fail })).rejects.toThrow(/invalid_grant/);
  });

  it('builds an auto-refreshing mcp_oauth vault credential', () => {
    const auth = buildVaultAuth({
      serverUrl: 'https://mcp.canva.com/mcp', tokens: { access_token: 'at', refresh_token: 'rt', expires_in: 60, scope: 'design:meta:read' },
      clientId: 'c1', clientSecret: null, authMethod: 'none', tokenEndpoint: 'https://mcp.canva.com/token',
      resource: 'https://mcp.canva.com/mcp', scopes: ['x'], now: 0,
    });
    expect(auth).toEqual({
      type: 'mcp_oauth', mcp_server_url: 'https://mcp.canva.com/mcp', access_token: 'at', expires_at: '1970-01-01T00:01:00.000Z',
      refresh: { refresh_token: 'rt', client_id: 'c1', token_endpoint: 'https://mcp.canva.com/token', token_endpoint_auth: { type: 'none' }, resource: 'https://mcp.canva.com/mcp', scope: 'design:meta:read' },
    });
    expect(buildVaultAuth({ serverUrl: 's', tokens: { access_token: 'at' }, clientId: 'c' }).refresh).toBeUndefined();
    expect(buildVaultAuth({ serverUrl: 's', tokens: { access_token: 'a', refresh_token: 'r' }, clientId: 'c', clientSecret: 'z', authMethod: 'client_secret_post', tokenEndpoint: 't' }).refresh.token_endpoint_auth)
      .toEqual({ type: 'client_secret_post', client_secret: 'z' });
  });

  it('normalizes server URLs the way vault matching does', () => {
    expect(normalizeServerUrl('https://MCP.Canva.com/mcp/')).toBe(normalizeServerUrl('https://mcp.canva.com/mcp'));
    expect(normalizeServerUrl('https://mcp.canva.com/other')).not.toBe(normalizeServerUrl('https://mcp.canva.com/mcp'));
  });
});

describe('schedules', () => {
  const allowedChannels = new Set(['C0AVAMXP17Y']);
  it('accepts valid jobs and rejects bad ones with reasons', () => {
    const raw = JSON.stringify([
      { name: 'weekly-recap', cron: '45 8 * * 1', channel: 'C0AVAMXP17Y', prompt: 'Recap the week.' },
      { name: 'holiday', cron: '0 9 * * 1', channel: 'C0C8DSN1BP0', prompt: 'x' },
      { name: 'weekly-recap', cron: '0 9 * * 1', channel: 'C0AVAMXP17Y', prompt: 'x' },
      { name: 'bad-cron', cron: '0 9 *', channel: 'C0AVAMXP17Y', prompt: 'x' },
      { cron: '0 9 * * 1', channel: 'C0AVAMXP17Y' },
    ]);
    const { jobs, errors } = parseSchedules(raw, { allowedChannels });
    expect(jobs).toEqual([{ name: 'weekly-recap', cron: '45 8 * * 1', timezone: 'America/New_York', channel: 'C0AVAMXP17Y', prompt: 'Recap the week.' }]);
    expect(errors).toHaveLength(4);
    expect(errors.join('\n')).toMatch(/not in BRIDGE_ALLOWED_CHANNELS/);
    expect(parseSchedules('', { allowedChannels })).toEqual({ jobs: [], errors: [] });
    expect(parseSchedules('{', { allowedChannels }).errors[0]).toMatch(/not valid JSON/);
  });

  it('tells the agent its reply is the post', () => {
    const prompt = scheduledPrompt({ name: 'weekly-recap', prompt: 'Recap.', timezone: 'America/New_York' }, new Date('2026-10-19T13:00:00Z'));
    expect(prompt).toMatch(/^Recap\.\n\n\(Scheduled job "weekly-recap", run on Monday, October 19, 2026\./);
  });
});

describe('personal servers', async () => {
  const { buildPersonalOverride, personalServersFromCredentials } = await import('../slack-bridge/lib/personal-servers.js');
  const agent = {
    id: 'agent_1',
    version: 3,
    mcp_servers: [{ type: 'url', name: 'altus', url: 'https://altus-core-production.up.railway.app/' }],
    tools: [{ type: 'mcp_toolset', mcp_server_name: 'altus', default_config: { enabled: true, permission_policy: { type: 'auto' } }, configs: [] }],
  };

  it('reads active MCP credentials only', () => {
    expect(personalServersFromCredentials([
      { display_name: 'Canva', auth: { mcp_server_url: 'https://mcp.canva.com/mcp' }, archived_at: null },
      { display_name: 'Old', auth: { mcp_server_url: 'https://old.example.com/mcp' }, archived_at: '2026-01-01' },
      { display_name: 'Env', auth: { type: 'environment_variable' }, archived_at: null },
      { auth: { mcp_server_url: 'https://mcp.zoho.com/abc' }, archived_at: null },
    ])).toEqual([
      { label: 'Canva', url: 'https://mcp.canva.com/mcp' },
      { label: 'mcp.zoho.com', url: 'https://mcp.zoho.com/abc' },
    ]);
  });

  it('appends each personal server and its toolset to the agent config', () => {
    const override = buildPersonalOverride(agent, [{ label: 'Canva', url: 'https://mcp.canva.com/mcp' }, { label: 'Zoho', url: 'https://mcp.zoho.com/abc' }]);
    expect(override).toMatchObject({ type: 'agent_with_overrides', id: 'agent_1', version: 3 });
    expect(override.mcp_servers.map((s) => s.name)).toEqual(['altus', 'personal_canva', 'personal_zoho']);
    expect(override.tools).toHaveLength(3);
    expect(override.tools[0]).toBe(agent.tools[0]);
    expect(override.tools[2]).toEqual({ type: 'mcp_toolset', mcp_server_name: 'personal_zoho', default_config: { enabled: true, permission_policy: { type: 'auto' } } });
  });

  it('skips servers the agent already declares and returns null when nothing is added', () => {
    expect(buildPersonalOverride(agent, [{ label: 'Altus', url: 'https://ALTUS-core-production.up.railway.app' }])).toBeNull();
    expect(buildPersonalOverride(agent, [])).toBeNull();
    const twice = buildPersonalOverride(agent, [{ label: 'Zoho', url: 'https://a.zoho.com/1' }, { label: 'Zoho', url: 'https://a.zoho.com/2' }]);
    expect(twice.mcp_servers.map((s) => s.name)).toEqual(['altus', 'personal_zoho', 'personal_zoho_2']);
  });
});

describe('Slack file upload and file selection', async () => {
  const { SlackClient } = await import('../slack-bridge/lib/slack.js');
  const { selectNewFiles } = await import('../slack-bridge/lib/session-files.js');

  it('uploads via getUploadURLExternal, the upload URL, then completeUploadExternal', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('files.getUploadURLExternal')) return { json: async () => ({ ok: true, upload_url: 'https://files.slack.com/up/1', file_id: 'F123' }) };
      if (url === 'https://files.slack.com/up/1') return { ok: true, status: 200 };
      return { json: async () => ({ ok: true }) };
    };
    const slack = new SlackClient({ token: 'xoxb-1', fetchImpl });
    const id = await slack.uploadFile({ channel: 'C1', thread_ts: '1.1', filename: 'r.pdf', bytes: Buffer.from('pdf!') });
    expect(id).toBe('F123');
    expect(calls.map((c) => c.url)).toEqual(['https://slack.com/api/files.getUploadURLExternal', 'https://files.slack.com/up/1', 'https://slack.com/api/files.completeUploadExternal']);
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body))).toEqual({ filename: 'r.pdf', length: '4' });
    expect(calls[1].init.body.toString()).toBe('pdf!');
    const complete = Object.fromEntries(new URLSearchParams(calls[2].init.body));
    expect(complete).toEqual({ files: JSON.stringify([{ id: 'F123', title: 'r.pdf' }]), channel_id: 'C1', thread_ts: '1.1' });
  });

  it('surfaces Slack errors such as a missing scope', async () => {
    const slack = new SlackClient({ token: 'x', fetchImpl: async () => ({ json: async () => ({ ok: false, error: 'missing_scope' }) }) });
    await expect(slack.uploadFile({ channel: 'C1', filename: 'a', bytes: Buffer.from('a') })).rejects.toThrow(/missing_scope/);
  });

  it('selects unsent, downloadable files within limits, oldest first', () => {
    const files = [
      { id: 'b', created_at: '2', size_bytes: 10 },
      { id: 'a', created_at: '1', size_bytes: 10 },
      { id: 'sent', created_at: '0' },
      { id: 'hidden', created_at: '3', downloadable: false },
      { id: 'huge', created_at: '4', size_bytes: 60 * 1024 * 1024 },
    ];
    expect(selectNewFiles(files, new Set(['sent'])).map((f) => f.id)).toEqual(['a', 'b']);
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `f${i}`, created_at: String(i).padStart(2, '0') }));
    expect(selectNewFiles(many, new Set())).toHaveLength(10);
  });
});

describe('memory', () => {
  it('builds memory resources by context', () => {
    expect(memoryResourcesFor({ isDm: false, memoryStoreId: null })).toEqual([]);
    expect(memoryResourcesFor({ isDm: false, memoryStoreId: 'm' })[0].access).toBe('read_write');
    expect(memoryResourcesFor({ isDm: true, memoryStoreId: 'm' })[0].access).toBe('read_only');
    expect(memoryResourcesFor({ isDm: true, memoryStoreId: 'm', dmAccess: 'read_write' })[0].access).toBe('read_write');
    for (const r of [memoryResourcesFor({ isDm: false, memoryStoreId: 'm' })[0], memoryResourcesFor({ isDm: true, memoryStoreId: 'm' })[0]]) {
      expect(r.instructions.length).toBeLessThanOrEqual(4096);
    }
  });

  it('parses DM access, defaulting to read-only', () => {
    expect(parseDmAccess(undefined)).toBe('read_only');
    expect(parseDmAccess('READ_WRITE')).toBe('read_write');
    expect(parseDmAccess('yes')).toBe('read_only');
  });

  it('seeds starter files without overwriting existing ones', async () => {
    const calls = [];
    const anthropic = { beta: { memoryStores: { memories: { create: async (id, params) => {
      calls.push({ id, ...params });
      if (params.path === HOLIDAY_TRACKER_PATH) throw Object.assign(new Error('conflict'), { status: 409 });
      if (params.path === '/decisions.md') return { id: 'mem_1' };
      throw Object.assign(new Error('boom'), { status: 500 });
    } } } } };
    const result = await seedMemoryStore(anthropic, 'memstore_team', [...MEMORY_SEEDS, { path: '/x.md', content: 'x' }]);
    expect(calls.map((c) => c.id)).toEqual(['memstore_team', 'memstore_team', 'memstore_team']);
    expect(result).toEqual({ created: ['/decisions.md'], existing: [HOLIDAY_TRACKER_PATH], failed: ['/x.md: boom'] });
  });

  it('seeds a holiday tracker with the 2026 dates and empty sections', () => {
    const tracker = MEMORY_SEEDS.find((s) => s.path === HOLIDAY_TRACKER_PATH).content;
    expect(tracker).toMatch(/Fri Nov 27: Black Friday/);
    expect(tracker).toMatch(/## Guides[\s\S]*## Picks[\s\S]*## Weekly priorities[\s\S]*## Decisions/);
    expect(Buffer.byteLength(tracker)).toBeLessThan(100 * 1024);
  });
});

