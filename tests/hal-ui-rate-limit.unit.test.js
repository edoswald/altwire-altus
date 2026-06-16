import { describe, expect, it } from 'vitest';
import { getHalUiRateLimitBucket } from '../lib/hal-ui-rate-limit.js';

describe('Hal UI rate-limit buckets', () => {
  it('puts chat requests in the dedicated chat bucket', () => {
    expect(getHalUiRateLimitBucket('POST', '/hal/chat')).toBe('chat');
  });

  it('puts high-volume authenticated UI REST routes in the UI bucket', () => {
    expect(getHalUiRateLimitBucket('GET', '/hal/writer/assignments')).toBe('ui');
    expect(getHalUiRateLimitBucket('POST', '/hal/chat-sessions')).toBe('ui');
    expect(getHalUiRateLimitBucket('GET', '/altwire/opportunities')).toBe('ui');
    expect(getHalUiRateLimitBucket('GET', '/altwire/digest')).toBe('ui');
  });

  it('leaves auth and non-UI routes on the global/auth limiter path', () => {
    expect(getHalUiRateLimitBucket('POST', '/hal/auth')).toBeNull();
    expect(getHalUiRateLimitBucket('GET', '/authorize')).toBeNull();
    expect(getHalUiRateLimitBucket('POST', '/mcp')).toBeNull();
  });

  it('does not rate-limit CORS preflight through UI buckets', () => {
    expect(getHalUiRateLimitBucket('OPTIONS', '/hal/chat')).toBeNull();
    expect(getHalUiRateLimitBucket('OPTIONS', '/hal/writer/assignments')).toBeNull();
  });
});
