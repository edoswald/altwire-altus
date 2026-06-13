import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

import { assembleSystemPrompt } from '../hal-harness.js';

describe('Altus Hal harness prompt', () => {
  it('guides autonomous sessions through SEO, research, admin email, and portable memory', async () => {
    const prompt = await assembleSystemPrompt(
      'autonomous',
      { name: 'Derek', interface: 'cron', scope: 'full' },
      { agentContext: 'altwire' },
    );

    expect(prompt).toContain('get_altwire_search_opportunities');
    expect(prompt).toContain('update_altwire_seo_fields');
    expect(prompt).toContain('altus_web_research');
    expect(prompt).toContain('altus_send_admin_email');
    expect(prompt).toContain('hal:portable_context:*');
    expect(prompt).toContain('Do not post to WordPress');
  });

  it('includes portable memory guidance for cross-backend Hal context', async () => {
    const prompt = await assembleSystemPrompt(
      'interactive',
      { name: 'Derek', interface: 'web', scope: 'full' },
      { agentContext: 'altwire' },
    );

    expect(prompt).toContain('## Portable Memory Guidance');
    expect(prompt).toContain('both Nimbus for Cirrusly and Altus for AltWire');
    expect(prompt).toContain('hal:portable_context:*');
    expect(prompt).toContain('mirrored to Nimbus');
  });
});
