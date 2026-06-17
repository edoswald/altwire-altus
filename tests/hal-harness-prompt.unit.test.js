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

  it('requires fresh tool verification for AltWire analytics and editorial intelligence prompts', async () => {
    const prompt = await assembleSystemPrompt(
      'interactive',
      { name: 'Derek', interface: 'web', scope: 'full' },
      { agentContext: 'altwire' },
    );

    expect(prompt).toContain('Do not answer these from memory alone');
    expect(prompt).toContain('get_altwire_top_pages');
    expect(prompt).toContain('get_altwire_traffic_sources');
    expect(prompt).toContain('get_altwire_site_search');
    expect(prompt).toContain('get_altwire_search_performance');
    expect(prompt).toContain('get_altwire_search_opportunities');
    expect(prompt).toContain('get_altwire_sitemap_health');
    expect(prompt).toContain('altus_get_data_health');
  });

  it('routes Phase 3 smoke-test prompts to their specific editorial tools', async () => {
    const prompt = await assembleSystemPrompt(
      'interactive',
      { name: 'Derek', interface: 'web', scope: 'full' },
      { agentContext: 'altwire' },
    );

    expect(prompt).toContain('"Any breaking news opportunities from the monitor?" -> get_news_opportunities');
    expect(prompt).toContain("\"Which past articles performed best, and what's the pattern?\" -> get_article_performance first");
    expect(prompt).toContain('get_news_performance_patterns');
    expect(prompt).toContain('"Where are our biggest coverage gaps right now?" -> get_story_opportunities first');
    expect(prompt).toContain('use refresh=true for smoke tests or "right now" checks');
    expect(prompt).toContain('"Is there anything in Postgres?"');
    expect(prompt).toContain('-> altus_get_data_health');
  });
});
