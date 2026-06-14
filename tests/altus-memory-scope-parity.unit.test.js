import { describe, it, expect } from 'vitest';
import { classifyKey, transformKey, stripPrefix } from '../handlers/altus-memory-scope.js';

describe('Altus memory scope parity', () => {
  it('keeps shared Hal prefixes shared', () => {
    expect(classifyKey('hal:soul')).toBe('shared');
    expect(classifyKey('hal:altwire:editorial_context')).toBe('shared');
    expect(classifyKey('hal:portable_context:admin_collaboration')).toBe('shared');
    expect(classifyKey('reflection:combined')).toBe('shared');
  });

  it('scopes admin-specific keys to the admin namespace', () => {
    expect(transformKey('42', 'notes:session')).toBe('altus:mem:42:notes:session');
    expect(stripPrefix('42', 'altus:mem:42:notes:session')).toBe('notes:session');
  });
});
