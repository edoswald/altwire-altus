/**
 * hal-signals.js — Laminar Signal definitions for Altus diagnostics.
 *
 * Registers Signals via Laminar API on startup. Each Signal:
 * - Runs on new traces matching trigger conditions
 * - Produces a structured payload accessible via SQL Editor
 * - Can trigger alerts (Slack/email) via Laminar alerting
 */

import { Laminar } from '@lmnr-ai/lmnr';
import { logger } from './logger.js';

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

export async function registerSignals() {
  if (!process.env.LMNR_PROJECT_API_KEY) return;

  for (const signal of SIGNALS) {
    try {
      await Laminar.signals.create(signal);
    } catch (err) {
      if (err.status !== 409) {
        logger.warn(`[altus-signals] Failed to register ${signal.name}:`, err.message);
      }
    }
  }
}
