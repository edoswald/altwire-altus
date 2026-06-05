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
    scheduledRun();

    stdout.emit('data', Buffer.from('ingest ok\n'));
    stderr.emit('data', Buffer.from('ingest warning\n'));

    expect(stdoutWrite).toHaveBeenCalledWith(Buffer.from('ingest ok\n'));
    expect(stderrWrite).toHaveBeenCalledWith(Buffer.from('ingest warning\n'));

    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });
});
