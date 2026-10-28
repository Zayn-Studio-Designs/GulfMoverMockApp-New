/**
 * External messaging adapters for the notification outbox. All are OFF until a
 * provider account is configured AND the channel is enabled in
 * platform_settings('notifications.channels'). A message is reported "sent"
 * only when the provider accepted it and returned a message id.
 *
 * Endpoint shapes follow each provider's public documentation as researched for
 * Phase 8 and MUST be confirmed against the contracted account before activation:
 *  - Email: Resend HTTP API (POST /emails, Idempotency-Key header).
 *  - SMS: Unifonic REST (registered Sender ID required in KSA; CST anti-spam rules).
 *  - WhatsApp: Meta WhatsApp Business Cloud API with pre-approved templates and opt-in.
 */
export type Channel = 'email' | 'sms' | 'whatsapp';
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OutgoingMessage {
  readonly outboxId: string; // idempotency key towards the provider
  readonly to: string;
  readonly templateKey: string;
  readonly locale: 'en' | 'ar';
  readonly link: string | null;
}

export class MessageError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export interface MessageProvider {
  readonly id: string;
  readonly channel: Channel;
  send(message: OutgoingMessage): Promise<{ providerMessageId: string }>;
}

/** Minimal, privacy-preserving content: an event headline and a link. No passenger data. */
const COPY: Record<string, { en: string; ar: string }> = {
  booking_created: { en: 'Your Gulf Mover reservation was created.', ar: 'تم إنشاء حجزك في Gulf Mover.' },
  tickets_created: { en: 'Your Gulf Mover tickets are ready.', ar: 'تذاكرك في Gulf Mover جاهزة.' },
  payment: { en: 'There is an update on your Gulf Mover payment.', ar: 'يوجد تحديث على عملية الدفع في Gulf Mover.' },
  sailing_suspended: { en: 'Your Gulf Mover sailing has been suspended.', ar: 'تم تعليق رحلتك في Gulf Mover.' },
  sailing_resumed: { en: 'Your Gulf Mover sailing has resumed.', ar: 'تم استئناف رحلتك في Gulf Mover.' },
  sailing_cancelled: { en: 'Your Gulf Mover sailing was cancelled.', ar: 'تم إلغاء رحلتك في Gulf Mover.' },
  booking_rescheduled: { en: 'Your Gulf Mover booking was rescheduled.', ar: 'تمت إعادة جدولة حجزك في Gulf Mover.' },
  refund_completed: { en: 'Your Gulf Mover refund was processed.', ar: 'تمت معالجة استرداد المبلغ في Gulf Mover.' },
  readiness_changed: { en: 'Operational status changed for your Gulf Mover sailing.', ar: 'تغيرت الحالة التشغيلية لرحلتك في Gulf Mover.' },
  boarding_recorded: { en: 'Boarding was recorded for your Gulf Mover ticket.', ar: 'تم تسجيل الصعود لتذكرتك في Gulf Mover.' },
};

export function renderMessage(templateKey: string, locale: 'en' | 'ar', link: string | null, appUrl: string): { subject: string; text: string } {
  const copy = COPY[templateKey] ?? COPY[templateKey.replace(/^request_.*/, 'request')] ?? { en: 'You have a new Gulf Mover notification.', ar: 'لديك إشعار جديد من Gulf Mover.' };
  const safeLink = link && /^\/[A-Za-z0-9/_-]*$/.test(link) ? `${appUrl}${link}` : appUrl;
  const subject = copy[locale];
  return { subject, text: `${subject}\n${safeLink}` };
}

export function createResendEmail(config: { apiKey: string; from: string; appUrl: string; fetch?: FetchLike }): MessageProvider {
  const doFetch: FetchLike = config.fetch ?? ((i, init) => fetch(i, init));
  return {
    id: 'resend', channel: 'email',
    async send(m) {
      const { subject, text } = renderMessage(m.templateKey, m.locale, m.link, config.appUrl);
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': m.outboxId },
        body: JSON.stringify({ from: config.from, to: [m.to], subject, text }),
      });
      const body = await res.json().catch(() => ({})) as { id?: unknown };
      if (!res.ok || typeof body.id !== 'string') throw new MessageError(`resend ${res.status}`, res.status >= 500 || res.status === 429);
      return { providerMessageId: body.id };
    },
  };
}

export function createUnifonicSms(config: { appSid: string; senderId: string; appUrl: string; fetch?: FetchLike }): MessageProvider {
  const doFetch: FetchLike = config.fetch ?? ((i, init) => fetch(i, init));
  return {
    id: 'unifonic', channel: 'sms',
    async send(m) {
      if (!/^\+?[0-9]{8,15}$/.test(m.to.replace(/[\s()-]/g, ''))) throw new MessageError('invalid phone', false);
      const { text } = renderMessage(m.templateKey, m.locale, m.link, config.appUrl);
      const form = new URLSearchParams({ AppSid: config.appSid, SenderID: config.senderId, Recipient: m.to.replace(/[^0-9]/g, ''), Body: text, CorrelationID: m.outboxId });
      const res = await doFetch('https://el.cloud.unifonic.com/rest/SMS/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
      });
      const body = await res.json().catch(() => ({})) as { success?: unknown; data?: { MessageID?: unknown } };
      if (!res.ok || body.success === false || body.data?.MessageID == null) throw new MessageError(`unifonic ${res.status}`, res.status >= 500 || res.status === 429);
      return { providerMessageId: String(body.data.MessageID) };
    },
  };
}

export function createWhatsAppCloud(config: { accessToken: string; phoneNumberId: string; apiVersion: string; templatePrefix: string; fetch?: FetchLike }): MessageProvider {
  const doFetch: FetchLike = config.fetch ?? ((i, init) => fetch(i, init));
  return {
    id: 'whatsapp-cloud', channel: 'whatsapp',
    async send(m) {
      const to = m.to.replace(/[^0-9]/g, '');
      if (to.length < 8) throw new MessageError('invalid phone', false);
      // Business-initiated messages must use a pre-approved template; the link is the only parameter.
      const res = await doFetch(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: {
          name: `${config.templatePrefix}${m.templateKey}`.slice(0, 512), language: { code: m.locale === 'ar' ? 'ar' : 'en' },
          components: m.link ? [{ type: 'body', parameters: [{ type: 'text', text: m.link }] }] : [] } }),
      });
      const body = await res.json().catch(() => ({})) as { messages?: Array<{ id?: unknown }> };
      const id = body.messages?.[0]?.id;
      if (!res.ok || typeof id !== 'string') throw new MessageError(`whatsapp ${res.status}`, res.status >= 500 || res.status === 429);
      return { providerMessageId: id };
    },
  };
}

export interface OutboxRow {
  readonly outbox_id: string; readonly channel: Channel; readonly template_key: string; readonly target: string | null;
  readonly locale: string; readonly recipient: string | null; readonly attempts: number;
}

export interface OutboxDb {
  claim(limit: number): Promise<OutboxRow[]>;
  complete(id: string, outcome: 'sent' | 'failed' | 'no_recipient', provider: string | null, providerMessageId: string | null, error: string | null): Promise<string>;
}

/** One dispatcher pass. Returns counts; never marks a message sent without a provider id. */
export async function dispatchOutbox(db: OutboxDb, providers: Partial<Record<Channel, MessageProvider>>, limit = 50) {
  const rows = await db.claim(limit);
  const counts = { claimed: rows.length, sent: 0, failed: 0, no_recipient: 0 };
  for (const row of rows) {
    const provider = providers[row.channel];
    if (!row.recipient) { await db.complete(row.outbox_id, 'no_recipient', null, null, null); counts.no_recipient += 1; continue; }
    if (!provider) { await db.complete(row.outbox_id, 'failed', null, null, 'provider_not_configured'); counts.failed += 1; continue; }
    try {
      const { providerMessageId } = await provider.send({ outboxId: row.outbox_id, to: row.recipient, templateKey: row.template_key,
        locale: row.locale === 'ar' ? 'ar' : 'en', link: row.target });
      await db.complete(row.outbox_id, 'sent', provider.id, providerMessageId, null);
      counts.sent += 1;
    } catch (e) {
      await db.complete(row.outbox_id, 'failed', provider.id, null, e instanceof Error ? e.message.slice(0, 200) : 'send failed');
      counts.failed += 1;
    }
  }
  return counts;
}
