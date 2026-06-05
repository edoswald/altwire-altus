import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: { query: vi.fn() },
  hasDbConfig: () => Boolean(process.env.ALTWIRE_DATABASE_URL || process.env.DATABASE_URL),
}));

import pool from '../lib/altus-db.js';
import {
  upsertChatPresence,
  isClientActiveInChat,
  listChatPresence,
} from '../handlers/altus-chat-presence.js';

describe('Altus chat presence parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
    delete process.env.ALTWIRE_DATABASE_URL;
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.ALTWIRE_DATABASE_URL;
    delete process.env.CHAT_ACTIVE_WINDOW_MINUTES;
  });

  it('upserts presence rows by client and session token hash', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await upsertChatPresence({
      client_id: 'hal-web',
      session_token_hash: 'abc123',
    });

    expect(result).toEqual({ success: true });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO altus_chat_presence'),
      ['hal-web', null, 'abc123'],
    );
  });

  it('returns false when no active row exists for a client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await isClientActiveInChat('hal-web');

    expect(result).toBe(false);
  });

  it('lists active presence rows by default', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ client_id: 'hal-web', admin_id: null, last_active_at: '2026-06-04T00:00:00.000Z' }],
    });

    const result = await listChatPresence();

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.presence[0].client_id).toBe('hal-web');
  });

  it('accepts ALTWIRE_DATABASE_URL as sufficient database config', async () => {
    delete process.env.DATABASE_URL;
    process.env.ALTWIRE_DATABASE_URL = 'postgres://altwire-test';
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await upsertChatPresence({
      client_id: 'hal-web',
      session_token_hash: 'abc123',
    });

    expect(result).toEqual({ success: true });
    expect(pool.query).toHaveBeenCalled();
  });
});
