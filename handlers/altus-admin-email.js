import { sendEmail } from '../lib/ses-client.js';
import { logger } from '../logger.js';

function configuredAdminEmails(env = process.env) {
  return [
    env.DEREK_EMAIL,
    env.ED_EMAIL,
    env.ALTUS_ADMIN_EMAILS,
    env.ALTUS_CC_EMAILS,
    env.ADMIN_EMAILS,
    env.HAL_ADMIN_EMAILS,
  ]
    .filter(Boolean)
    .flatMap(value => String(value).split(','))
    .map(extractEmailAddress)
    .filter(Boolean);
}

function extractEmailAddress(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return '';
  return normalized.match(/<([^<>@\s]+@[^<>@\s]+)>/)?.[1] ?? normalized;
}

function splitAddressList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

export function getAltusAdminEmailSet(env = process.env) {
  return new Set([
    'ed@weatherwhys.company',
    ...configuredAdminEmails(env),
  ]);
}

export function isAdminEmailAllowed({ to, cc } = {}, env = process.env) {
  const allowed = getAltusAdminEmailSet(env);
  const recipients = [
    ...splitAddressList(to),
    ...splitAddressList(cc),
  ].map(extractEmailAddress).filter(Boolean);

  return recipients.length > 0 && recipients.every(email => allowed.has(email));
}

export async function sendAltusAdminEmail({ to, cc, subject, body }) {
  if (!isAdminEmailAllowed({ to, cc })) {
    return {
      success: false,
      exit_reason: 'scope_denied',
      message: 'Altus may only send autonomous admin email to configured admin recipients.',
    };
  }

  const ccAddresses = splitAddressList(cc);
  try {
    await sendEmail({
      to: String(to).trim(),
      cc: ccAddresses,
      subject,
      text: body,
      html: '',
    });
    logger.info('[altus-admin-email] sent admin email', { to, cc: ccAddresses, subject });
    return { success: true, to, cc: ccAddresses, subject };
  } catch (err) {
    logger.error('[altus-admin-email] send failed', { to, subject, error: err.message });
    return { success: false, exit_reason: 'tool_error', message: err.message };
  }
}
