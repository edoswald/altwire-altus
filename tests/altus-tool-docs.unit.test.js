import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyToolDocs, SERVER_INSTRUCTIONS, TOOL_DOCS } from '../lib/altus-tool-docs.js';
import { CORE_TOOLS } from '../lib/altus-profile.js';

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function inlineDescription(name) {
  const start = indexSource.indexOf(`scopedRegister(\n    '${name}'`);
  const block = indexSource.slice(start, indexSource.indexOf('\n  );', start));
  return block.match(/description: '((?:[^'\\]|\\.)*)'/)?.[1] ?? '';
}

const WRITE_TOOLS = [
  'reingest_altwire_archive', 'update_story_opportunity', 'update_altwire_seo_fields',
];

describe('core tool docs', () => {
  it('every core tool has a title, annotations, and a description', () => {
    for (const name of CORE_TOOLS) {
      const docs = TOOL_DOCS[name];
      expect(docs, name).toBeDefined();
      expect(docs.title, name).toBeTruthy();
      expect(docs.annotations, name).toBeDefined();
      const description = docs.description ?? inlineDescription(name);
      expect(description.length, name).toBeGreaterThan(60);
    }
  });

  it('documents no tool outside the core set', () => {
    expect(Object.keys(TOOL_DOCS).filter((name) => !CORE_TOOLS.has(name))).toEqual([]);
  });

  it('marks writes as non-read-only and only the live-site SEO write as destructive', () => {
    for (const name of CORE_TOOLS) {
      const { readOnlyHint, destructiveHint } = TOOL_DOCS[name].annotations;
      expect(readOnlyHint, name).toBe(!WRITE_TOOLS.includes(name));
      expect(Boolean(destructiveHint), name).toBe(name === 'update_altwire_seo_fields');
    }
  });

  it('core descriptions and server instructions are free of Hal-era references', () => {
    for (const name of CORE_TOOLS) {
      const description = TOOL_DOCS[name].description ?? inlineDescription(name);
      expect(description, name).not.toMatch(/\bHal\b|\bDerek\b|agent_memory/);
    }
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\bHal\b|\bDerek\b/);
  });

  it('server instructions only name tools that exist in core', () => {
    const named = [...SERVER_INSTRUCTIONS.matchAll(/\b((?:get|search|analyze|update|add|altus)_[a-z_]+)\b/g)].map((m) => m[1]);
    const unknown = named.filter((n) => !CORE_TOOLS.has(n) && !n.endsWith('_'));
    expect(unknown).toEqual([]);
  });
});

describe('applyToolDocs', () => {
  it('overrides description, adds title and annotations, keeps the input schema', () => {
    const schema = { query: 'zod-shape' };
    const merged = applyToolDocs('search_altwire_archive', { description: 'old', inputSchema: schema });
    expect(merged.inputSchema).toBe(schema);
    expect(merged.description).toBe(TOOL_DOCS.search_altwire_archive.description);
    expect(merged.title).toBe('Search the AltWire archive');
    expect(merged.annotations).toMatchObject({ readOnlyHint: true, title: 'Search the AltWire archive' });
  });

  it('keeps the inline description when docs only add annotations', () => {
    const merged = applyToolDocs('get_altwire_morning_digest', { description: 'inline' });
    expect(merged.description).toBe('inline');
    expect(merged.annotations.readOnlyHint).toBe(true);
  });

  it('leaves undocumented tools untouched', () => {
    const config = { description: 'legacy' };
    expect(applyToolDocs('hal_read_memory', config)).toBe(config);
  });
});
