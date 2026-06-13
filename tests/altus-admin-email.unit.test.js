import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sendEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn(),
}));

vi.mock('../lib/ses-client.js', () => ({
  sendEmail,
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  getAltusAdminEmailSet,
  isAdminEmailAllowed,
  sendAltusAdminEmail,
} from '../handlers/altus-admin-email.js';

describe('Altus admin email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DEREK_EMAIL', 'derek@altwire.com');
    vi.stubEnv('ED_EMAIL', 'ed@cirruslyweather.com');
    vi.stubEnv('ALTUS_ADMIN_EMAILS', 'ops@example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds an admin set from Derek, Ed, and configured admin lists', () => {
    const admins = getAltusAdminEmailSet();

    expect(admins.has('derek@altwire.com')).toBe(true);
    expect(admins.has('ed@cirruslyweather.com')).toBe(true);
    expect(admins.has('ops@example.com')).toBe(true);
    expect(admins.has('ed@weatherwhys.company')).toBe(true);
  });

  it('allows display-name admin recipients and admin CC recipients', () => {
    expect(isAdminEmailAllowed({
      to: 'Derek <derek@altwire.com>',
      cc: 'ops@example.com, Ed <ed@cirruslyweather.com>',
    })).toBe(true);
  });

  it('blocks any non-admin recipient before SES is called', async () => {
    const result = await sendAltusAdminEmail({
      to: 'derek@altwire.com',
      cc: 'reader@example.com',
      subject: 'Altus heartbeat question',
      body: 'Can you confirm this is worth pursuing?',
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      exit_reason: 'scope_denied',
    }));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends admin-only email through the SES helper', async () => {
    sendEmail.mockResolvedValue({ success: true });

    const result = await sendAltusAdminEmail({
      to: 'Derek <derek@altwire.com>',
      cc: 'ops@example.com',
      subject: 'Altus heartbeat update',
      body: 'I completed the SEO follow-through.',
    });

    expect(result.success).toBe(true);
    expect(sendEmail).toHaveBeenCalledWith({
      to: 'Derek <derek@altwire.com>',
      cc: ['ops@example.com'],
      subject: 'Altus heartbeat update',
      text: 'I completed the SEO follow-through.',
      html: '',
    });
  });
});
