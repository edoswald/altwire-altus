/**
 * Files the agent writes in its sandbox (reports, spreadsheets, slide decks
 * from the docx/xlsx/pptx/pdf skills) are attached to the Slack conversation
 * after each turn. Managed Agents exposes them through the Files API, scoped
 * to the session; they appear a second or two after the turn ends.
 */

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_TURN = 10;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Files in a session listing that should be sent now. */
export function selectNewFiles(files, alreadySent) {
  return files
    .filter((f) => f && f.id && !alreadySent.has(f.id))
    .filter((f) => f.downloadable !== false)
    .filter((f) => !f.size_bytes || f.size_bytes <= MAX_FILE_BYTES)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, MAX_FILES_PER_TURN);
}

/**
 * List the session's files, polling briefly because output files are
 * indexed shortly after the turn ends. Returns files not yet sent.
 */
export async function findNewSessionFiles(anthropic, sessionId, alreadySent, { delaysMs = [1500, 3500], sleep = wait } = {}) {
  const seen = new Map();
  for (const delay of delaysMs) {
    await sleep(delay);
    for await (const file of anthropic.beta.files.list({ scope_id: sessionId, betas: ['managed-agents-2026-04-01'] })) {
      seen.set(file.id, file);
    }
  }
  return selectNewFiles([...seen.values()], alreadySent);
}

/** Download a file's bytes. */
export async function downloadFile(anthropic, fileId) {
  const response = await anthropic.beta.files.download(fileId);
  return Buffer.from(await response.arrayBuffer());
}
