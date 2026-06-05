import { describe, expect, it } from 'vitest';
import {
  authenticateHalWebToken,
  identifyCompatibleHalClient,
  isAllowedAltusRestToken,
  signHalWebSessionToken,
} from '../lib/altus-auth-compat.js';

const env = {
  HAL_SESSION_SECRET: 'test-secret',
  HAL_KEY: 'shared-hal-key',
  ALTUS_ADMIN_TOKEN: 'altus-admin-token',
  HAL_KEY_ED_WEB: 'ed-web-key',
  HAL_KEY_DEREK_WEB: 'derek-web-key',
  HAL_KEY_ED_IOS: 'ed-ios-key',
  OAUTH_CLIENT_ID_ED: 'oauth-ed',
};

describe('altus auth compatibility helpers', () => {
  it('accepts Hal web session tokens and maps them to compatible client ids', () => {
    const token = signHalWebSessionToken(
      { name: 'Ed', interface: 'web', autonomous: false, scope: 'full' },
      env,
    );

    expect(authenticateHalWebToken(token, env)).toEqual(
      expect.objectContaining({ name: 'Ed', interface: 'web' }),
    );
    expect(identifyCompatibleHalClient(token, env)).toBe('oauth-ed');
  });

  it('accepts known Hal web API keys for Altus REST compatibility', () => {
    expect(isAllowedAltusRestToken('ed-web-key', { allowHalKey: false }, env)).toBe(true);
    expect(isAllowedAltusRestToken('shared-hal-key', { allowHalKey: true }, env)).toBe(true);
    expect(isAllowedAltusRestToken('altus-admin-token', { allowAltusAdminToken: true }, env)).toBe(true);
  });

  it('rejects non-web Hal keys from UI compatibility auth', () => {
    expect(authenticateHalWebToken('ed-ios-key', env)).toBeNull();
    expect(isAllowedAltusRestToken('ed-ios-key', {}, env)).toBe(false);
  });
});
