/**
 * handlers/altus-onboarding.js
 *
 * Multi-admin onboarding for Altus.
 * Adapted from cirrusly-nimbus/hal-onboarding.js for AltWire editorial context.
 *
 * Five-phase calibration: workload → tracking → checkins → communication → perch
 * Per-admin preferences stored in agent_memory.
 * Soul evolution via Claude Haiku when onboarding completes.
 *
 * Exports:
 *   checkOnboardingStatus({ admin_id })
 *   saveOnboardingResponse({ admin_id, phase, response })
 *   getOnboardingPreferences({ admin_id })
 *   getPerchAgenda()
 *   updatePerchAgenda({ admin_id, monitoring })
 *   resetOnboarding({ admin_id, confirm })
 *   evolveSoul(learnings)
 *   deriveCommStyle(response)
 *   mergeMonitoring(adminMonitoring)
 */

import Anthropic from '@anthropic-ai/sdk';
import pool from '../lib/altus-db.js';
import { readAgentMemory, writeAgentMemory } from '../lib/altus-db.js';
import { logAiUsage } from '../lib/ai-cost-tracker.js';
import { logger } from '../logger.js';

const AGENT = 'hal';

const PHASES = ['workload', 'tracking', 'checkins', 'communication', 'perch'];

const DEFAULT_AGENDA = {
  monitoring: [],
  admin_monitoring: {},
  scheduled_jobs: [
    'morning_digest_8am_et',
    'nightly_reflection_5am_et',
    'heartbeat_2hour',
    'review_tracker_weekly',
  ],
  last_updated: null,
};

const SOUL_STUB = 'Altus is a calm, knowledgeable, direct editorial assistant for AltWire, an independent music news publication. It provides editorial intelligence, content research, and AI-assisted writing guidance.';

const COMM_KEYWORDS = {
  confirm_all:     ['everything', 'all', 'every', 'confirm', 'tell me', 'full'],
  exceptions_only: ['only problems', 'only when', 'exceptions', "don't tell me", 'quiet', 'minimal'],
};

export function deriveCommStyle(response) {
  const lower = response.toLowerCase();
  for (const kw of COMM_KEYWORDS.confirm_all)     if (lower.includes(kw)) return 'confirm_all';
  for (const kw of COMM_KEYWORDS.exceptions_only) if (lower.includes(kw)) return 'exceptions_only';
  return 'balanced';
}

export function mergeMonitoring(adminMonitoring) {
  const all = Object.values(adminMonitoring).flat();
  return [...new Set(all.map(t => t.toLowerCase().trim()))];
}

export async function checkOnboardingStatus({ admin_id }) {
  if (!admin_id) return { success: false, exit_reason: 'missing_admin_id' };

  const result = await readAgentMemory(AGENT, `altus:onboarding_state:${admin_id}`);

  if (!result.success) {
    return { onboarding_required: true, phase: 'init', admin_id };
  }

  const value = result.value;

  if (value === 'complete') {
    return { onboarding_required: false, phase: 'complete', admin_id };
  }

  if (value === 'reset') {
    return { onboarding_required: true, phase: 'init', admin_id, is_recalibration: true };
  }

  return { onboarding_required: true, phase: value, admin_id };
}

export async function saveOnboardingResponse({ admin_id, phase, response }) {
  if (!admin_id) return { success: false, exit_reason: 'missing_admin_id' };
  if (!PHASES.includes(phase)) return { success: false, exit_reason: 'invalid_phase' };

  await writeAgentMemory(AGENT, `altus:onboarding_response:${admin_id}:${phase}`, response);

  if (phase === 'communication') {
    const style = deriveCommStyle(response);
    await writeAgentMemory(AGENT, `altus:pref:${admin_id}:communication_style`, style);
  }

  if (phase === 'perch') {
    const topics = response.split(/[,\n]+/).map(t => t.trim()).filter(Boolean);

    const agendaResult = await readAgentMemory(AGENT, 'altus:perch_agenda');
    const agenda = agendaResult.success ? JSON.parse(agendaResult.value) : { ...DEFAULT_AGENDA, admin_monitoring: {} };

    if (!agenda.admin_monitoring) agenda.admin_monitoring = {};
    agenda.admin_monitoring[String(admin_id)] = topics;
    agenda.monitoring = mergeMonitoring(agenda.admin_monitoring);
    agenda.last_updated = new Date().toISOString();
    agenda.scheduled_jobs = DEFAULT_AGENDA.scheduled_jobs;

    await writeAgentMemory(AGENT, 'altus:perch_agenda', JSON.stringify(agenda));
  }

  await writeAgentMemory(AGENT, `altus:onboarding_state:${admin_id}`, phase);

  const phaseChecks = await Promise.all(
    PHASES.map(p => readAgentMemory(AGENT, `altus:onboarding_response:${admin_id}:${p}`)),
  );
  const allComplete = phaseChecks.every(r => r.success);

  if (allComplete) {
    await writeAgentMemory(AGENT, `altus:onboarding_state:${admin_id}`, 'complete');
    const allResponses = phaseChecks.map(r => r.value).join('\n\n');
    try {
      await evolveSoul(allResponses);
    } catch (err) {
      logger.error('altus-onboarding: evolveSoul failed during completion', { error: err.message });
    }
    return { success: true, next_phase: 'complete', admin_id };
  }

  const currentIdx = PHASES.indexOf(phase);
  const nextPhase = currentIdx < PHASES.length - 1 ? PHASES[currentIdx + 1] : phase;
  return { success: true, next_phase: nextPhase, admin_id };
}

export async function getOnboardingPreferences({ admin_id }) {
  if (!admin_id) return { success: false, exit_reason: 'missing_admin_id' };

  const prefix = `altus:pref:${admin_id}:`;
  const { rows } = await pool.query(
    `SELECT key, value FROM agent_memory WHERE agent = $1 AND key LIKE $2`,
    [AGENT, `${prefix}%`],
  );

  if (rows.length === 0) {
    return { success: true, preferences: {}, onboarding_required: true, admin_id };
  }

  const preferences = {};
  for (const row of rows) {
    preferences[row.key] = row.value;
  }

  return { success: true, preferences, admin_id };
}

export async function getPerchAgenda() {
  const result = await readAgentMemory(AGENT, 'altus:perch_agenda');

  if (!result.success) {
    return { ...DEFAULT_AGENDA };
  }

  try {
    return JSON.parse(result.value);
  } catch {
    return { ...DEFAULT_AGENDA };
  }
}

export async function updatePerchAgenda({ admin_id, monitoring }) {
  if (!admin_id) return { success: false, exit_reason: 'missing_admin_id' };

  const agendaResult = await readAgentMemory(AGENT, 'altus:perch_agenda');
  const agenda = agendaResult.success ? JSON.parse(agendaResult.value) : { ...DEFAULT_AGENDA, admin_monitoring: {} };

  if (!agenda.admin_monitoring) agenda.admin_monitoring = {};
  agenda.admin_monitoring[String(admin_id)] = monitoring;
  agenda.monitoring = mergeMonitoring(agenda.admin_monitoring);
  agenda.last_updated = new Date().toISOString();
  agenda.scheduled_jobs = DEFAULT_AGENDA.scheduled_jobs;

  await writeAgentMemory(AGENT, 'altus:perch_agenda', JSON.stringify(agenda));
  return { success: true, admin_id };
}

export async function resetOnboarding({ admin_id, confirm }) {
  if (!admin_id) return { success: false, exit_reason: 'missing_admin_id' };
  if (!confirm) return { success: false, exit_reason: 'confirm_required' };

  await writeAgentMemory(AGENT, `altus:onboarding_state:${admin_id}`, 'reset');
  return { success: true, admin_id };
}

export async function evolveSoul(learnings) {
  const soulResult = await readAgentMemory(AGENT, 'altus:soul');
  const currentSoul = soulResult.success ? soulResult.value : SOUL_STUB;

  const prompt = `You are Altus, an editorial AI assistant for AltWire. A new admin has completed onboarding. Incorporate any new context into your identity, but preserve your core traits: calm, knowledgeable, direct.

Current soul:
${currentSoul}

New learnings from onboarding:
${learnings}

Return a single paragraph describing your identity as Altus for AltWire. Be specific about editorial context, tone, and what admins can expect from you. Do not invent traits not supported by the learnings.`;

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    await logAiUsage('evolve_soul', response.model, response.usage);
    const newSoul = response.content?.[0]?.text ?? currentSoul;
    await writeAgentMemory(AGENT, 'altus:soul', newSoul);
    logger.info('evolveSoul: soul updated');
    return { success: true };
  } catch (err) {
    logger.error('evolveSoul: failed', { error: err.message });
    return { success: false, exit_reason: 'ai_error', message: err.message };
  }
}