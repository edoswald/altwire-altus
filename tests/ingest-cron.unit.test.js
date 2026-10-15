import { beforeEach, describe, expect, it, vi } from 'vitest';

const scheduleMock = vi.fn();
const spawnMock = vi.fn();
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('node-cron', () => ({
  default: {
    schedule: scheduleMock,
  },
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../logger.js', () => ({
  logger,
}));

const lastRunMock = vi.fn();
vi.mock('../lib/altus-db.js', () => ({
  getLastSuccessfulIngestRun: lastRunMock,
}));

function createStream() {
  const listeners = new Map();
  return {
    on(event, handler) {
      listeners.set(event, handler);
    },
    emit(event, value) {
      const handler = listeners.get(event);
      if (handler) handler(value);
    },
  };
}

describe('ingest-cron', () => {
  beforeEach(() => {
    vi.resetModules();
    scheduleMock.mockReset();
    spawnMock.mockReset();
    lastRunMock.mockReset();
    lastRunMock.mockResolvedValue(null);
    Object.values(logger).forEach(fn => fn.mockReset());
  });

  it('forwards child stdout to process.stdout and child stderr to process.stderr', async () => {
    const stdout = createStream();
    const stderr = createStream();
    const child = createStream();
    child.stdout = stdout;
    child.stderr = stderr;
    spawnMock.mockReturnValue(child);

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { startIngestCron } = await import('../lib/ingest-cron.js');
    startIngestCron();

    expect(scheduleMock).toHaveBeenCalledOnce();
    const scheduledRun = scheduleMock.mock.calls[0][1];
    await scheduledRun();
    expect(spawnMock.mock.calls[0][1]).toEqual(expect.arrayContaining([expect.stringMatching(/ingest\.js$/), '--recent']));

    stdout.emit('data', Buffer.from('ingest ok\n'));
    stderr.emit('data', Buffer.from('ingest warning\n'));

    expect(stdoutWrite).toHaveBeenCalledWith(Buffer.from('ingest ok\n'));
    expect(stderrWrite).toHaveBeenCalledWith(Buffer.from('ingest warning\n'));

    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });

  function fakeChild() {
    const child = createStream();
    child.stdout = createStream();
    child.stderr = createStream();
    return child;
  }

  it('only scores reviews when a clean ingest ran within the last few hours', async () => {
    spawnMock.mockReturnValue(fakeChild());
    const { runIngest } = await import('../lib/ingest-cron.js');
    const now = Date.parse('2026-10-16T04:00:00Z');

    await runIngest({ lastRunLookup: async () => '2026-10-16T03:05:00Z', now });
    expect(spawnMock.mock.calls[0][1]).toEqual(expect.arrayContaining([expect.stringMatching(/score-reviews\.js$/), '--limit', '40']));

    await runIngest({ lastRunLookup: async () => '2026-10-15T03:05:00Z', now });
    expect(spawnMock.mock.calls[1][1]).toEqual(expect.arrayContaining([expect.stringMatching(/ingest\.js$/), '--recent']));
  });

  it('uses ALTUS_INGEST_CRON when valid and falls back to 03:00 UTC otherwise', async () => {
    const { startIngestCron } = await import('../lib/ingest-cron.js');
    startIngestCron({ expression: '0 4 * * *' });
    expect(scheduleMock.mock.calls[0][0]).toBe('0 4 * * *');
    expect(scheduleMock.mock.calls[0][2]).toEqual({ timezone: 'UTC' });
  });
});
