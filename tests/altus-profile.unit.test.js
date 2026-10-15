import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CORE_TOOLS,
  LEGACY_ONLY_CRONS,
  getAltusProfile,
  isCronEnabled,
  isPathEnabled,
  isToolEnabled,
  shouldRunCrons,
} from '../lib/altus-profile.js';

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const registeredTools = new Set([...indexSource.matchAll(/scopedRegister\(\s*'([^']+)'/g)].map((m) => m[1]));
const scheduledCrons = new Set([...indexSource.matchAll(/scheduleCron\(\s*'([^']+)'/g)].map((m) => m[1]));

const core = { ALTUS_PROFILE: 'core' };

describe('altus profile', () => {
  it('defaults to legacy', () => {
    expect(getAltusProfile({})).toBe('legacy');
    expect(getAltusProfile({ ALTUS_PROFILE: 'nonsense' })).toBe('legacy');
    expect(getAltusProfile({ ALTUS_PROFILE: ' Core ' })).toBe('core');
  });

  it('every core tool is actually registered in index.js', () => {
    const missing = [...CORE_TOOLS].filter((name) => !registeredTools.has(name));
    expect(missing).toEqual([]);
  });

  it('core exposes exactly the core tool set; legacy exposes everything', () => {
    const enabledInCore = [...registeredTools].filter((name) => isToolEnabled(name, core));
    expect(new Set(enabledInCore)).toEqual(CORE_TOOLS);
    expect([...registeredTools].every((name) => isToolEnabled(name, {}))).toBe(true);
  });

  it('core drops Hal runtime, Writer, review tracker, Slack, and link evaluator tools', () => {
    for (const name of ['hal_read_memory', 'create_article_assignment', 'altus_create_review', 'send_slack_dm', 'evaluate_link_fitness', 'altus_create_climb', 'altus_web_research', 'generate_chart', 'altus_topic_synthesis']) {
      expect(isToolEnabled(name, core)).toBe(false);
    }
  });

  it('legacy-only crons are real cron names and are skipped in core', () => {
    for (const name of LEGACY_ONLY_CRONS) {
      expect(scheduledCrons.has(name)).toBe(true);
      expect(isCronEnabled(name, core)).toBe(false);
      expect(isCronEnabled(name, {})).toBe(true);
    }
    for (const name of ['news_monitor', 'story_opportunities', 'performance_snapshot', 'morning_digest', 'weekly_brief', 'audit_batch']) {
      expect(isCronEnabled(name, core)).toBe(true);
    }
  });

  it('ALTUS_RUN_CRONS can name the only jobs to run, and ALTUS_SKIP_CRONS removes jobs', () => {
    const only = { ALTUS_PROFILE: 'core', ALTUS_RUN_CRONS: 'daily_ingest' };
    expect(shouldRunCrons(only)).toBe(true);
    expect(isCronEnabled('daily_ingest', only)).toBe(true);
    expect(isCronEnabled('news_monitor', only)).toBe(false);
    expect(isCronEnabled('daily_ingest', { ALTUS_RUN_CRONS: ' Daily_Ingest , weekly_brief ' })).toBe(true);
    expect(isCronEnabled('weekly_brief', { ALTUS_RUN_CRONS: 'true' })).toBe(true);

    const skip = { ALTUS_SKIP_CRONS: 'daily_ingest' };
    expect(isCronEnabled('daily_ingest', skip)).toBe(false);
    expect(isCronEnabled('news_monitor', skip)).toBe(true);
  });

  it('ALTUS_RUN_CRONS=false disables every cron in either profile', () => {
    expect(shouldRunCrons({})).toBe(true);
    expect(shouldRunCrons({ ALTUS_RUN_CRONS: 'false' })).toBe(false);
    expect(isCronEnabled('news_monitor', { ALTUS_RUN_CRONS: 'false' })).toBe(false);
    expect(isCronEnabled('news_monitor', { ...core, ALTUS_RUN_CRONS: 'FALSE' })).toBe(false);
  });

  it('core serves only MCP, OAuth, and health paths', () => {
    for (const path of ['/mcp', '/', '/health', '/authorize', '/oauth/token', '/oauth/register', '/.well-known/oauth-authorization-server']) {
      expect(isPathEnabled(path, core)).toBe(true);
    }
    for (const path of ['/hal/chat', '/hal/writer/summary', '/events/abc', '/slack/events', '/altwire/digest']) {
      expect(isPathEnabled(path, core)).toBe(false);
      expect(isPathEnabled(path, {})).toBe(true);
    }
  });
});
