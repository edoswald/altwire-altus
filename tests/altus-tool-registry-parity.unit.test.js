import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function extractScopedToolNames(source) {
  return [...source.matchAll(/scopedRegister\(\s*'([^']+)'/g)].map((match) => match[1]);
}

describe('Altus shared Hal registry parity', () => {
  it('retains the baseline shared Hal tools already expected in Altus', () => {
    const names = new Set(extractScopedToolNames(indexSource));

    expect(names.has('hal_read_memory')).toBe(true);
    expect(names.has('hal_write_memory')).toBe(true);
    expect(names.has('hal_list_memory')).toBe(true);
    expect(names.has('query_altus_events')).toBe(true);
    expect(names.has('get_altus_audit_log')).toBe(true);
    expect(names.has('altus_check_onboarding_status')).toBe(true);
    expect(names.has('altus_get_onboarding_preferences')).toBe(true);
    expect(names.has('altus_get_perch_agenda')).toBe(true);
    expect(names.has('altus_list_action_items')).toBe(true);
    expect(names.has('altus_manage_action_item')).toBe(true);
    expect(names.has('altus_get_action_item_stats')).toBe(true);
    expect(names.has('altus_get_data_health')).toBe(true);
    expect(names.has('altus_get_session_trace')).toBe(true);
    expect(names.has('altus_web_research')).toBe(true);
    expect(names.has('altus_topic_synthesis')).toBe(true);
    expect(names.has('altus_search_skills')).toBe(true);
    expect(names.has('altus_send_admin_email')).toBe(true);
  });

  it('serves story opportunities from the queue, with refresh running a scan first', () => {
    const storyToolBlock = indexSource.match(/scopedRegister\(\s*'get_story_opportunities'[\s\S]+?\n  \);/)?.[0] ?? '';

    expect(storyToolBlock).toContain('refresh');
    expect(storyToolBlock).toContain('runStoryScan()');
    expect(storyToolBlock).toContain('listStoryQueue({ status, limit })');
  });

  it('runs the story scan on weekday mornings before the digest', () => {
    const scanBlock = indexSource.match(/scheduleCron\(\s*'story_scan',\s*'0 5 \* \* 1-5'[\s\S]+?\}, \{ timezone: 'America\/New_York' \}\);/)?.[0] ?? '';

    expect(scanBlock).toContain('runStoryScan()');
  });

  it('exposes an explicit article tracking registration tool for performance snapshots', () => {
    const names = new Set(extractScopedToolNames(indexSource));
    const trackingToolBlock = indexSource.match(/scopedRegister\(\s*'altus_register_article_tracking'[\s\S]+?\n  \);/)?.[0] ?? '';

    expect(names.has('altus_register_article_tracking')).toBe(true);
    expect(trackingToolBlock).toContain('registerArticleForTracking');
    expect(trackingToolBlock).toContain('article_url');
    expect(trackingToolBlock).toContain('published_at');
  });
});
