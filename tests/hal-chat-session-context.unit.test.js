import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');

describe('Hal chat session context', () => {
  it('runs in-process MCP tool calls under the chat session id', () => {
    const chatToolCall = /sessionIdStorage\.run\(session_id,[\s\S]+mcpClient\.callTool/;

    expect(indexSource).toMatch(chatToolCall);
  });
});
