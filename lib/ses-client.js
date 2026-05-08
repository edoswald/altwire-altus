import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { logger } from '../logger.js';

const ses = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' });

export async function sendEmail({ to, subject, html, text }) {
  const params = {
    Source: process.env.ALTUS_FROM_EMAIL || 'hal@cirruslyweather.com',
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: html, Charset: 'UTF-8' },
        Text: { Data: text || stripHtml(html), Charset: 'UTF-8' },
      },
    },
  };
  try {
    const command = new SendEmailCommand(params);
    await ses.send(command);
    return { success: true };
  } catch (err) {
    logger.error('[ses-client] sendEmail failed', { to, subject, error: err.message });
    return { success: false, error: err.message };
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}