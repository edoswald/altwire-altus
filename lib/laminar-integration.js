import { logger } from '../logger.js';

const SIGNALS = [
  {
    name: 'altus_agent_loop_detected',
    prompt: 'Detect when the Altus agent loops on the same tool without making progress. Look for consecutive iterations where the same tool_name appears 5 or more times in a single session.',
    outputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        iteration_count: { type: 'number' },
      },
      required: ['tool_name', 'iteration_count'],
    },
    trigger: { trace_name: ['altus_session', 'altus_heartbeat'] },
  },
  {
    name: 'altus_session_error',
    prompt: 'Detect when an Altus session encounters an error that prevents completion.',
    outputSchema: {
      type: 'object',
      properties: {
        error_type: { type: 'string' },
        error_message: { type: 'string' },
      },
      required: ['error_type', 'error_message'],
    },
    trigger: { trace_name: ['altus_session', 'altus_heartbeat'] },
  },
  {
    name: 'altus_tool_failure',
    prompt: 'Detect when a tool call returns an error in its response. Look for tool responses containing an "error" field.',
    outputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        error: { type: 'string' },
      },
      required: ['tool_name', 'error'],
    },
    trigger: { trace_name: ['altus_session'] },
  },
  {
    name: 'altus_high_token_session',
    prompt: 'Detect sessions with unusually high token usage (input + output > 50,000 tokens).',
    outputSchema: {
      type: 'object',
      properties: {
        total_tokens: { type: 'number' },
        input_tokens: { type: 'number' },
        output_tokens: { type: 'number' },
      },
      required: ['total_tokens', 'input_tokens', 'output_tokens'],
    },
    trigger: { trace_name: ['altus_session'] },
  },
  {
    name: 'altus_long_running_session',
    prompt: 'Detect autonomous sessions that run longer than 5 minutes (300 seconds).',
    outputSchema: {
      type: 'object',
      properties: {
        duration_seconds: { type: 'number' },
      },
      required: ['duration_seconds'],
    },
    trigger: { trace_name: ['altus_heartbeat'] },
  },
];

async function defaultLoadLaminar() {
  return import('@lmnr-ai/lmnr');
}

async function defaultLoadAnthropic() {
  return import('@anthropic-ai/sdk');
}

export async function initializeLaminar({
  projectApiKey = process.env.LMNR_PROJECT_API_KEY,
  loadLaminar = defaultLoadLaminar,
  loadAnthropic = defaultLoadAnthropic,
} = {}) {
  if (!projectApiKey) {
    return false;
  }

  try {
    const { Laminar } = await loadLaminar();
    const Anthropic = (await loadAnthropic()).default;

    Laminar.initialize({
      projectApiKey,
      metadata: { service: 'altus' },
      instrumentModules: { anthropic: Anthropic },
    });

    if (typeof Laminar.patch === 'function') {
      Laminar.patch({ anthropic: Anthropic });
    }

    logger.info('Laminar initialized — shared project, service: altus');
    return true;
  } catch (err) {
    logger.warn('Laminar initialization failed', { error: err.message });
    return false;
  }
}

export async function registerLaminarSignals({
  projectApiKey = process.env.LMNR_PROJECT_API_KEY,
  loadLaminar = defaultLoadLaminar,
} = {}) {
  if (!projectApiKey) {
    return false;
  }

  let Laminar;
  try {
    const lmnr = await loadLaminar();
    Laminar = lmnr.Laminar ?? lmnr.default?.Laminar;
  } catch (err) {
    logger.warn('[altus-signals] Laminar SDK not available:', err.message);
    return false;
  }

  if (!Laminar) {
    logger.warn('[altus-signals] Laminar SDK loaded but Laminar export not found');
    return false;
  }

  const createSignal = Laminar.signals?.create;
  if (typeof createSignal !== 'function') {
    logger.warn('[altus-signals] Laminar SDK does not expose a signals client; skipping registration');
    return false;
  }

  for (const signal of SIGNALS) {
    try {
      await createSignal.call(Laminar.signals, signal);
    } catch (err) {
      if (err.status !== 409) {
        logger.warn(`[altus-signals] Failed to register ${signal.name}:`, err.message);
      }
    }
  }

  return true;
}
