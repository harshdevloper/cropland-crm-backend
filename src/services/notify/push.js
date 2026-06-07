// Push channel — Firebase Cloud Messaging for the Farmer App (PRD §10, §12).
// firebase-admin is dynamically imported and only initialised when a service
// account is configured, so the server boots fine without FCM credentials.

import { env } from '../../config/env.js';

export const pushConfigured = Boolean(env.fcm.projectId && env.fcm.clientEmail && env.fcm.privateKey);

let messaging = null;
async function getMessaging() {
  if (messaging) return messaging;
  if (!pushConfigured) return null;
  const admin = (await import('firebase-admin')).default;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.fcm.projectId,
        clientEmail: env.fcm.clientEmail,
        privateKey: env.fcm.privateKey,
      }),
    });
  }
  messaging = admin.messaging();
  return messaging;
}

/** Send a push notification to many device tokens. Returns a dispatch summary. */
export async function sendPush(tokens, title, body) {
  const list = [...new Set((tokens || []).filter(Boolean))];
  if (!list.length) return { channel: 'PUSH', sent: 0, note: 'no device tokens' };
  const m = await getMessaging();
  if (!m) return { channel: 'PUSH', sent: 0, skipped: true, note: 'FCM not configured' };
  const res = await m.sendEachForMulticast({
    tokens: list,
    notification: { title, body },
  });
  return { channel: 'PUSH', sent: res.successCount, failed: res.failureCount };
}
