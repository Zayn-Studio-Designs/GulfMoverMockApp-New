// Supabase Edge Function (Deno): drains the notification outbox on a schedule.
// NOT DEPLOYED by this repository. Invoke with the service role (cron / scheduler).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GM_PUBLIC_APP_URL,
//   RESEND_API_KEY + GM_EMAIL_FROM            (email, when approved)
//   UNIFONIC_APP_SID + UNIFONIC_SENDER_ID      (SMS, registered Sender ID)
//   WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_API_VERSION + WHATSAPP_TEMPLATE_PREFIX
// A channel only receives queued rows once enabled in platform_settings('notifications.channels').
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createResendEmail, createUnifonicSms, createWhatsAppCloud, dispatchOutbox, type Channel, type MessageProvider, type OutboxDb } from '../_shared/messaging/providers.ts';

declare const Deno: { env: { toObject(): Record<string, string> }; serve(h: (r: Request) => Promise<Response>): void };
const env = Deno.env.toObject();

Deno.serve(async (req: Request) => {
  // Only the service role may trigger a dispatch run.
  if (req.headers.get('Authorization') !== `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`) return new Response('unauthorized', { status: 401 });
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const db: OutboxDb = {
    async claim(limit) {
      const { data, error } = await admin.rpc('claim_outbox_batch', { p_limit: limit });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    async complete(id, outcome, provider, providerMessageId, err) {
      const { data, error } = await admin.rpc('complete_outbox_delivery', { p_outbox_id: id, p_outcome: outcome, p_provider: provider,
        p_provider_message_id: providerMessageId, p_error: err });
      if (error) throw new Error(error.message);
      return data as string;
    },
  };
  const providers: Partial<Record<Channel, MessageProvider>> = {};
  if (env.RESEND_API_KEY && env.GM_EMAIL_FROM) providers.email = createResendEmail({ apiKey: env.RESEND_API_KEY, from: env.GM_EMAIL_FROM, appUrl: env.GM_PUBLIC_APP_URL });
  if (env.UNIFONIC_APP_SID && env.UNIFONIC_SENDER_ID) providers.sms = createUnifonicSms({ appSid: env.UNIFONIC_APP_SID, senderId: env.UNIFONIC_SENDER_ID, appUrl: env.GM_PUBLIC_APP_URL });
  if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
    providers.whatsapp = createWhatsAppCloud({ accessToken: env.WHATSAPP_ACCESS_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      apiVersion: env.WHATSAPP_API_VERSION ?? 'v21.0', templatePrefix: env.WHATSAPP_TEMPLATE_PREFIX ?? 'gm_' });
  }
  const counts = await dispatchOutbox(db, providers, 50);
  return new Response(JSON.stringify(counts), { headers: { 'Content-Type': 'application/json' } });
});
