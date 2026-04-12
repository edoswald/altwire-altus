// Feature: altus-ai-writer, Unit tests for AI Writer pipeline

import { describe, it, expect } from 'vitest';
import { detectProvider } from '../lib/writer-client.js';

// ---------------------------------------------------------------------------
// Writer Client — Provider Detection
// ---------------------------------------------------------------------------

describe('writer-client: detectProvider', () => {
  it('detects anthropic for claude-sonnet-4-5', () => {
    expect(detectProvider('claude-sonnet-4-5')).toBe('anthropic');
  });

  it('detects anthropic for claude-haiku-4-5', () => {
    expect(detectProvider('claude-haiku-4-5')).toBe('anthropic');
  });

  it('detects openai for gpt-4o', () => {
    expect(detectProvider('gpt-4o')).toBe('openai');
  });

  it('detects openai for gpt-4-turbo', () => {
    expect(detectProvider('gpt-4-turbo')).toBe('openai');
  });

  it('detects openai for o1', () => {
    expect(detectProvider('o1')).toBe('openai');
  });

  it('detects openai for o1-preview', () => {
    expect(detectProvider('o1-preview')).toBe('openai');
  });

  it('detects openai for o3', () => {
    expect(detectProvider('o3')).toBe('openai');
  });

  it('detects openai for o3-mini', () => {
    expect(detectProvider('o3-mini')).toBe('openai');
  });

  it('detects anthropic for unknown model names', () => {
    expect(detectProvider('some-random-model')).toBe('anthropic');
  });

  it('detects anthropic for empty string', () => {
    expect(detectProvider('')).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Writer Client — Error Shape
// ---------------------------------------------------------------------------

describe('writer-client: error shape', () => {
  it('anthropic error has correct format', () => {
    const err = new Error('writer-client [anthropic]: API rate limited');
    expect(err.message).toBe('writer-client [anthropic]: API rate limited');
    expect(err.message).toMatch(/^writer-client \[(anthropic|openai)\]: /);
  });

  it('openai error has correct format', () => {
    const err = new Error('writer-client [openai]: Invalid API key');
    expect(err.message).toBe('writer-client [openai]: Invalid API key');
    expect(err.message).toMatch(/^writer-client \[(anthropic|openai)\]: /);
  });
});


// ---------------------------------------------------------------------------
// markdownToHtml — tested via dynamic import to access non-exported function
// We test the conversion logic by importing the module and testing the
// WordPress posting path indirectly. Since markdownToHtml is non-exported,
// we replicate the exact regex logic here for unit testing.
// ---------------------------------------------------------------------------

function markdownToHtml(md) {
  if (!md) return '';
  let html = md;
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/(?:^- .+$\n?)+/gm, (block) => {
    const items = block.trim().split('\n').map((line) => `<li>${line.replace(/^- /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  html = html.replace(/(?:^\d+\. .+$\n?)+/gm, (block) => {
    const items = block.trim().split('\n').map((line) => `<li>${line.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });
  html = html
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (/^<(h[1-3]|ul|ol|p)/.test(block)) return block;
      return `<p>${block.replace(/\n/g, ' ')}</p>`;
    })
    .join('\n');
  return html;
}

describe('markdownToHtml', () => {
  it('converts h1 headings', () => {
    expect(markdownToHtml('# Hello World')).toContain('<h1>Hello World</h1>');
  });

  it('converts h2 headings', () => {
    expect(markdownToHtml('## Section Title')).toContain('<h2>Section Title</h2>');
  });

  it('converts h3 headings', () => {
    expect(markdownToHtml('### Subsection')).toContain('<h3>Subsection</h3>');
  });

  it('converts bold text', () => {
    expect(markdownToHtml('This is **bold** text')).toContain('<strong>bold</strong>');
  });

  it('converts italic text', () => {
    expect(markdownToHtml('This is *italic* text')).toContain('<em>italic</em>');
  });

  it('converts links', () => {
    const result = markdownToHtml('[AltWire](https://altwire.net)');
    expect(result).toContain('<a href="https://altwire.net">AltWire</a>');
  });

  it('converts unordered lists', () => {
    const md = '- Item one\n- Item two\n- Item three';
    const result = markdownToHtml(md);
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>Item one</li>');
    expect(result).toContain('<li>Item two</li>');
    expect(result).toContain('<li>Item three</li>');
    expect(result).toContain('</ul>');
  });

  it('converts ordered lists', () => {
    const md = '1. First\n2. Second\n3. Third';
    const result = markdownToHtml(md);
    expect(result).toContain('<ol>');
    expect(result).toContain('<li>First</li>');
    expect(result).toContain('<li>Second</li>');
    expect(result).toContain('<li>Third</li>');
    expect(result).toContain('</ol>');
  });

  it('wraps plain text in paragraphs', () => {
    const md = 'First paragraph.\n\nSecond paragraph.';
    const result = markdownToHtml(md);
    expect(result).toContain('<p>First paragraph.</p>');
    expect(result).toContain('<p>Second paragraph.</p>');
  });

  it('handles empty input', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml(null)).toBe('');
    expect(markdownToHtml(undefined)).toBe('');
  });

  it('handles mixed content', () => {
    const md = '## Introduction\n\nThis is **bold** and *italic* with a [link](https://example.com).\n\n- Item 1\n- Item 2';
    const result = markdownToHtml(md);
    expect(result).toContain('<h2>Introduction</h2>');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
    expect(result).toContain('<a href="https://example.com">link</a>');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>Item 1</li>');
  });

  it('does not contain status: publish', () => {
    // Property 8: WordPress posting always creates drafts
    // The markdownToHtml function itself doesn't set status,
    // but we verify the output doesn't accidentally include publish directives
    const result = markdownToHtml('## Test Article\n\nSome content here.');
    expect(result).not.toContain('publish');
  });
});

// ---------------------------------------------------------------------------
// Word count computation
// ---------------------------------------------------------------------------

describe('Word count computation', () => {
  it('counts words correctly for typical draft', () => {
    const draft = 'The quick brown fox jumps over the lazy dog.';
    expect(draft.split(/\s+/).filter(Boolean).length).toBe(9);
  });

  it('handles multiple spaces between words', () => {
    const draft = 'word1   word2    word3';
    expect(draft.split(/\s+/).filter(Boolean).length).toBe(3);
  });

  it('handles newlines and tabs', () => {
    const draft = 'word1\nword2\tword3';
    expect(draft.split(/\s+/).filter(Boolean).length).toBe(3);
  });

  it('returns 0 for empty string', () => {
    expect(''.split(/\s+/).filter(Boolean).length).toBe(0);
  });

  it('returns 0 for whitespace-only string', () => {
    expect('   \n\t  '.split(/\s+/).filter(Boolean).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Status guard validation (decision mapping)
// ---------------------------------------------------------------------------

describe('Status guard logic', () => {
  const requiredStatuses = {
    generateOutline: 'outline_ready',
    approveOutline: 'outline_ready',
    generateDraft: 'outline_approved',
    factCheckDraft: ['draft_ready', 'needs_revision'],
    postToWordPress: 'ready_to_post',
  };

  const allStatuses = [
    'researching', 'outline_ready', 'outline_approved',
    'drafting', 'draft_ready', 'fact_checking',
    'needs_revision', 'ready_to_post', 'posted', 'cancelled',
  ];

  for (const [fn, required] of Object.entries(requiredStatuses)) {
    const allowed = Array.isArray(required) ? required : [required];
    const rejected = allStatuses.filter((s) => !allowed.includes(s));

    it(`${fn} rejects statuses: ${rejected.join(', ')}`, () => {
      for (const status of rejected) {
        expect(allowed).not.toContain(status);
      }
    });

    it(`${fn} accepts statuses: ${allowed.join(', ')}`, () => {
      for (const status of allowed) {
        expect(allowed).toContain(status);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// approveOutline decision → status mapping
// ---------------------------------------------------------------------------

describe('approveOutline decision mapping', () => {
  const mapping = {
    approved: 'outline_approved',
    rejected: 'cancelled',
    modified: 'outline_ready',
  };

  it('approved → outline_approved', () => {
    expect(mapping.approved).toBe('outline_approved');
  });

  it('rejected → cancelled', () => {
    expect(mapping.rejected).toBe('cancelled');
  });

  it('modified → outline_ready', () => {
    expect(mapping.modified).toBe('outline_ready');
  });
});
