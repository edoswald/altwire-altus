/**
 * Cross-service scope trust boundary (Altus side).
 *
 * Altus and Nimbus share HAL_SESSION_SECRET. Altus must only trust the embedded
 * `scope` for tokens it minted itself (iss: 'altus'); a token minted by a peer
 * (Nimbus) must have its scope re-derived from local identity policy.
 */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  authenticateHalWebToken,
  signHalWebSessionToken,
  localScopeForWebIdentity,
} from '../lib/altus-auth-compat.js';

const env = {
  HAL_SESSION_SECRET: 'cross-service-test-secret',
  HAL_KEY_ED_WEB: 'ed-web-key',
  HAL_KEY_DEREK_WEB: 'derek-web-key',
  HAL_KEY_TEST_WEB: 'test-web-key',
};

// Mint a token as a peer service (Nimbus) would: shared secret, foreign issuer.
function signAsPeer({ name, scope, iss = 'nimbus' }) {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'HAL' }));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = b64(JSON.stringify({ name, interface: 'web', autonomous: false, scope, iss, exp }));
  const sig = createHmac('sha256', env.HAL_SESSION_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

describe('Altus scope trust boundary', () => {
  it('honors the embedded scope for self-issued tokens', () => {
    const token = signHalWebSessionToken(
      { name: 'Ed', interface: 'web', autonomous: false, scope: 'full' },
      env,
    );
    expect(authenticateHalWebToken(token, env).scope).toBe('full');
  });

  it('self-issued tokens carry iss: altus', () => {
    const token = signHalWebSessionToken(
      { name: 'Ed', interface: 'web', autonomous: false, scope: 'full' },
      env,
    );
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.iss).toBe('altus');
  });

  it('ignores a foreign scope and re-derives identity locally', () => {
    // Nimbus stamps Ed as 'full'; Altus policy keeps Ed full but the point is it
    // is re-derived locally, not taken from the token.
    const edToken = signAsPeer({ name: 'Ed', scope: 'operational' });
    expect(authenticateHalWebToken(edToken, env).scope).toBe('full');

    const derekToken = signAsPeer({ name: 'Derek', scope: 'full' });
    expect(authenticateHalWebToken(derekToken, env).scope).toBe('operational');
  });

  it('re-derives unknown peer identities to guest', () => {
    const token = signAsPeer({ name: 'Nobody', scope: 'full' });
    expect(authenticateHalWebToken(token, env).scope).toBe('guest');
  });
});

describe('localScopeForWebIdentity', () => {
  it('maps known web identities by name', () => {
    expect(localScopeForWebIdentity({ name: 'Ed' }, env)).toBe('full');
    expect(localScopeForWebIdentity({ name: 'Derek' }, env)).toBe('operational');
    expect(localScopeForWebIdentity({ name: 'Test' }, env)).toBe('guest');
  });

  it('defaults unknown identities to guest', () => {
    expect(localScopeForWebIdentity({ name: 'Nobody' }, env)).toBe('guest');
    expect(localScopeForWebIdentity(null, env)).toBe('guest');
  });
});
