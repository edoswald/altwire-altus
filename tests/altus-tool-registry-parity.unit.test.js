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
    expect(names.has('altus_get_session_trace')).toBe(true);
    expect(names.has('altus_web_research')).toBe(true);
    expect(names.has('altus_topic_synthesis')).toBe(true);
    expect(names.has('altus_search_skills')).toBe(true);
  });
});
