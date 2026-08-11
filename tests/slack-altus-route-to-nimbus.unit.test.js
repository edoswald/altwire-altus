/**
 * routeToNimbus() must send the shared-secret X-Altwire-Token header that
 * Nimbus's handleAltwireInboundRequest requires. Nimbus fails closed (401)
 * without it — see docs/AltWire_AI_Agent_Platform_Unified_Spec.md §1.2.2 and
 * cirrusly-nimbus/docs/hal-layer-strategy.md §3.8 seam S4.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from '../logger.js';
import { routeToNimbus } from '../handlers/slack-altus.js';

const ORIGINAL_ENV = { ...process.env };

describe('routeToNimbus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NIMBUS_SLACK_WEBHOOK_URL = 'https://nimbus.example.com/slack/altwire-events';
    process.env.ALTWIRE_WEBHOOK_TOKEN = 'shared-secret-token';
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it('sends X-Altwire-Token matching ALTWIRE_WEBHOOK_TOKEN', async () => {
    await routeToNimbus({
      message: 'hello',
      history: [],
      channel: 'C123',
      threadTs: null,
      isDm: false,
      slackUserId: 'U123',
      agentContext: 'altwire',
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://nimbus.example.com/slack/altwire-events');
    expect(opts.headers['X-Altwire-Token']).toBe('shared-secret-token');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('does not call fetch and warns when ALTWIRE_WEBHOOK_TOKEN is unset', async () => {
    delete process.env.ALTWIRE_WEBHOOK_TOKEN;

    await routeToNimbus({
      message: 'hello',
      history: [],
      channel: 'C123',
      threadTs: null,
      isDm: false,
      slackUserId: 'U123',
      agentContext: 'altwire',
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ALTWIRE_WEBHOOK_TOKEN'),
    );
  });

  it('does not call fetch when NIMBUS_SLACK_WEBHOOK_URL is unset', async () => {
    delete process.env.NIMBUS_SLACK_WEBHOOK_URL;

    await routeToNimbus({
      message: 'hello',
      history: [],
      channel: 'C123',
      threadTs: null,
      isDm: false,
      slackUserId: 'U123',
      agentContext: 'altwire',
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
