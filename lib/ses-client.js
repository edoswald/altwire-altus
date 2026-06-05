import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { logger } from '../logger.js';

const sesConfig = {
  region: process.env.AWS_REGION || 'us-east-1',
};
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  sesConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
}
const ses = new SESClient(sesConfig);

export async function sendEmail({ to, cc, subject, html, text }) {
  const destination = { ToAddresses: [to] };
  if (Array.isArray(cc) && cc.length > 0) {
    destination.CcAddresses = cc;
  }
  const params = {
    Source: process.env.ALTUS_FROM_EMAIL || 'hal@cirruslyweather.com',
    Destination: destination,
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: html || '', Charset: 'UTF-8' },
        Text: { Data: text || (html ? stripHtml(html) : ''), Charset: 'UTF-8' },
      },
    },
  };
  try {
    const command = new SendEmailCommand(params);
    await ses.send(command);
    return { success: true };
  } catch (err) {
    logger.error('[ses-client] sendEmail failed', { to, subject, error: err.message });
    throw err;
  }
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}