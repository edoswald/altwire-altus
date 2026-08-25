import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dispatchSlackEvent,
  scheduleSlackMessage,
} from '../handlers/slack-altus.js';

describe('Altus Slack cross-service contracts', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.NIMBUS_SLACK_WEBHOOK_URL = 'https://nimbus.example/slack/altwire-events';
    process.env.ALTWIRE_WEBHOOK_TOKEN = 'altwire-test-token';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.NIMBUS_SLACK_WEBHOOK_URL;
    delete process.env.ALTWIRE_WEBHOOK_TOKEN;
    vi.restoreAllMocks();
  });

  it('authenticates Altus to Nimbus forwarding with the scoped webhook token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await dispatchSlackEvent({
      type: 'message',
      channel_type: 'im',
      channel: 'D1',
      ts: '1.0',
      text: 'status?',
      user: 'U1',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://nimbus.example/slack/altwire-events',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Altwire-Token': 'altwire-test-token',
        },
      }),
    );
  });

  it('does not forward to Nimbus when the scoped webhook token is missing', async () => {
    delete process.env.ALTWIRE_WEBHOOK_TOKEN;
    globalThis.fetch = vi.fn();

    await dispatchSlackEvent({
      type: 'message',
      channel_type: 'im',
      channel: 'D1',
      ts: '1.0',
      text: 'status?',
      user: 'U1',
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('passes integer Unix seconds unchanged to Slack scheduling', async () => {
    const scheduleMessage = vi.fn().mockResolvedValue({
      scheduled_message_id: 'Q1',
      post_at: 1_800_000_000,
    });

    await expect(scheduleSlackMessage('C1', 'later', 1_800_000_000, null, {
      client: { chat: { scheduleMessage } },
    })).resolves.toMatchObject({
      success: true,
      scheduled_message_id: 'Q1',
    });

    expect(scheduleMessage).toHaveBeenCalledWith({
      channel: 'C1',
      text: 'later',
      post_at: 1_800_000_000,
    });
  });

  it('rejects non-integer Slack schedule timestamps before calling Slack', async () => {
    const scheduleMessage = vi.fn();

    await expect(scheduleSlackMessage('C1', 'later', 1_800_000_000.5, null, {
      client: { chat: { scheduleMessage } },
    })).resolves.toEqual({ success: false, reason: 'invalid_post_at' });

    expect(scheduleMessage).not.toHaveBeenCalled();
  });

  it('rejects past Slack schedule timestamps before calling Slack', async () => {
    const scheduleMessage = vi.fn();

    await expect(scheduleSlackMessage('C1', 'later', 1, null, {
      client: { chat: { scheduleMessage } },
    })).resolves.toEqual({ success: false, reason: 'invalid_post_at' });

    expect(scheduleMessage).not.toHaveBeenCalled();
  });
});
