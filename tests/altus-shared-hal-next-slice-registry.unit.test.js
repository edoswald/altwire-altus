import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function extractScopedToolNames(source) {
  return [...source.matchAll(/scopedRegister\(\s*'([^']+)'/g)].map((match) => match[1]);
}

describe('Altus shared Hal next-slice registry', () => {
  it('registers the next shared-Hal parity tools', () => {
    const names = new Set(extractScopedToolNames(indexSource));

    expect(names.has('altus_list_chat_presence')).toBe(true);
    expect(names.has('altus_list_documents')).toBe(true);
    expect(names.has('altus_get_document')).toBe(true);
    expect(names.has('altus_save_document')).toBe(true);
    expect(names.has('altus_record_commitment')).toBe(true);
    expect(names.has('altus_list_commitments')).toBe(true);
    expect(names.has('altus_update_commitment')).toBe(true);
    expect(names.has('altus_record_watch_item')).toBe(true);
    expect(names.has('altus_list_watch_items')).toBe(true);
    expect(names.has('altus_update_watch_item')).toBe(true);
    expect(names.has('altus_record_autonomy_note')).toBe(true);
  });
});
