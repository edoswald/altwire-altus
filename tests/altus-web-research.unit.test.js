import { describe, it, expect } from 'vitest';
import { isPrivateUrl, isBinaryUrl } from '../handlers/altus-web-research.js';

describe('Altus web research parity helpers', () => {
  it('blocks private URLs', () => {
    expect(isPrivateUrl('http://localhost:3000')).toBe(true);
    expect(isPrivateUrl('https://example.com')).toBe(false);
  });

  it('detects binary targets', () => {
    expect(isBinaryUrl('https://example.com/report.pdf')).toBe(true);
    expect(isBinaryUrl('https://example.com/post')).toBe(false);
  });
});
