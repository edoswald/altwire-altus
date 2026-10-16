import { describe, expect, it, vi } from 'vitest';
import { createProgress, describeStep, renderProgress } from '../slack-bridge/lib/progress.js';
import { runTurn } from '../slack-bridge/lib/agent-session.js';

describe('progress labels', () => {
  it('describes Altus and built-in tools in plain words', () => {
    expect(describeStep('search_altwire_archive', { query: 'deftones live' })).toEqual(['Searching the archive for “deftones live”', 'Searched the archive for “deftones live”']);
    expect(describeStep('search_altwire_archive', {})).toEqual(['Browsing the archive', 'Browsed the archive']);
    expect(describeStep('get_altwire_morning_digest')[1]).toBe('Pulled the analytics snapshot');
    expect(describeStep('read', { file_path: '/mnt/memory/team/decisions.md' })).toEqual(['Reading notes (decisions.md)', 'Read notes (decisions.md)']);
    expect(describeStep('web_fetch', { url: 'https://www.pitchfork.com/news/x' })[0]).toBe('Reading pitchfork.com');
    expect(describeStep('get_altwire_brand_new_thing')).toEqual(['Using brand new thing', 'Used brand new thing']);
  });

  it('renders done, failed and running steps, collapsing repeats and old steps', () => {
    const s = (status, label) => ({ status, running: `${label}…`, done: label });
    expect(renderProgress([s('done', 'Searched'), s('done', 'Searched'), s('error', 'Read page'), s('running', 'Checking')]))
      .toBe('_Working on it…_\n✓ Searched ×2\n✗ Read page\n⏳ Checking…');
    const many = Array.from({ length: 10 }, (_, i) => s('done', `Step ${i}`));
    const text = renderProgress(many, { maxLines: 3 });
    expect(text).toBe('_Working on it…_\n_…7 earlier steps_\n✓ Step 7\n✓ Step 8\n✓ Step 9');
  });
});

describe('createProgress', () => {
  it('throttles edits and never edits after stop()', async () => {
    vi.useFakeTimers();
    const update = vi.fn(async () => {});
    const p = createProgress(update, { minIntervalMs: 1000 });
    p.start('a', 'get_altwire_top_pages', {});
    p.end('a');
    p.start('b', 'get_altwire_site_analytics', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledTimes(1);
    p.end('b');
    await vi.advanceTimersByTimeAsync(500);
    expect(update).toHaveBeenCalledTimes(1);
    await p.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(update).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('runTurn steps', () => {
  it('reports tool calls and results, and survives a failing callback', async () => {
    const events = [
      { type: 'agent.tool_use', id: 'u1', name: 'web_search', input: { query: 'x' } },
      { type: 'agent.tool_result', tool_use_id: 'u1', is_error: true },
      { type: 'agent.message', content: [{ type: 'text', text: 'Done.' }] },
      { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
    const client = { beta: { sessions: { events: {
      stream: async () => ({ async *[Symbol.asyncIterator]() { yield* events; } }),
      send: async () => {},
    } } } };
    const calls = [];
    const result = await runTurn(client, 's', 'hi', { onStep: { start: (...a) => calls.push(['start', ...a]), end: (...a) => calls.push(['end', ...a]) } });
    expect(calls).toEqual([['start', 'u1', 'web_search', { query: 'x' }], ['end', 'u1', true]]);
    expect(result.text).toBe('Done.');

    const broken = await runTurn(client, 's', 'hi', { onStep: { start: () => { throw new Error('boom'); } }, logger: { warn: () => {} } });
    expect(broken.text).toBe('Done.');
  });
});
