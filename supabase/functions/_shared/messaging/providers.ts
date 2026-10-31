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

/** Provider calls are bounded: a hung provider becomes a retryable failure instead of
 *  stalling the whole run until the platform kills it mid-send. */
export const PROVIDER_TIMEOUT_MS = 10_000;
export function withTimeout(f: FetchLike, ms = PROVIDER_TIMEOUT_MS): FetchLike {
  return async (input, init) => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race as well as abort: a client that ignores the signal still cannot hang the run.
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctrl.abort(); reject(new MessageError('provider timeout', true)); }, ms); });
    try { return await Promise.race([f(input, { ...init, signal: ctrl.signal }), timeout]); }
    catch (e) { throw e instanceof MessageError ? e : new MessageError(`provider unreachable: ${e instanceof Error ? e.message.slice(0, 80) : ''}`, true); }
    finally { clearTimeout(timer); }
  };
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
  const doFetch: FetchLike = withTimeout(config.fetch ?? ((i, init) => fetch(i, init)));
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
  const doFetch: FetchLike = withTimeout(config.fetch ?? ((i, init) => fetch(i, init)));
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
  const doFetch: FetchLike = withTimeout(config.fetch ?? ((i, init) => fetch(i, init)));
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

/** Retries recording the outcome; a send that the provider accepted must never be re-sent
 *  just because the database write that records it failed once. */
async function recordWithRetry(op: () => Promise<string>, attempts = 3, sleep = (ms: number) => new Promise(r => setTimeout(r, ms))) {
  for (let i = 1; ; i++) {
    try { return await op(); } catch (e) { if (i >= attempts) throw e; await sleep(250 * 4 ** (i - 1)); }
  }
}

export interface DispatchOptions {
  /** Rows claimed per database round trip (claim only what this run will process). */
  readonly chunk?: number;
  /** Stop claiming new rows after this long, well inside the edge-function wall-clock limit. */
  readonly budgetMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<unknown>;
}

/**
 * One dispatcher pass, at-least-once and idempotent:
 * - rows are claimed in small chunks under a lease (FOR UPDATE SKIP LOCKED in the database),
 *   so parallel runs never take the same row and a crashed run's rows are retried later;
 * - a provider failure is recorded as `failed` (retried with exponential backoff, max 5 attempts);
 * - a SUCCESSFUL send is never turned into a failure: recording it is retried, and if that
 *   still fails the row keeps its lease and the error is surfaced (counts.unrecorded) for alerting;
 * - providers receive the outbox id as their idempotency/correlation key.
 * Never marks a message sent without a provider id.
 */
export async function dispatchOutbox(db: OutboxDb, providers: Partial<Record<Channel, MessageProvider>>, limit = 50, options: DispatchOptions = {}) {
  const chunk = Math.max(1, Math.min(options.chunk ?? 10, limit));
  const budgetMs = options.budgetMs ?? 90_000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const started = now();
  const counts = { claimed: 0, sent: 0, failed: 0, no_recipient: 0, unrecorded: 0 };
  while (counts.claimed < limit && now() - started < budgetMs) {
    const rows = await db.claim(Math.min(chunk, limit - counts.claimed));
    if (rows.length === 0) break;
    counts.claimed += rows.length;
    for (const row of rows) {
      const provider = providers[row.channel];
      if (!row.recipient) { await recordWithRetry(() => db.complete(row.outbox_id, 'no_recipient', null, null, null), 3, sleep); counts.no_recipient += 1; continue; }
      if (!provider) { await recordWithRetry(() => db.complete(row.outbox_id, 'failed', null, null, 'provider_not_configured'), 3, sleep); counts.failed += 1; continue; }
      let providerMessageId: string;
      try {
        ({ providerMessageId } = await provider.send({ outboxId: row.outbox_id, to: row.recipient, templateKey: row.template_key,
          locale: row.locale === 'ar' ? 'ar' : 'en', link: row.target }));
      } catch (e) {
        await recordWithRetry(() => db.complete(row.outbox_id, 'failed', provider.id, null, e instanceof Error ? e.message.slice(0, 200) : 'send failed'), 3, sleep);
        counts.failed += 1;
        continue;
      }
      try {
        await recordWithRetry(() => db.complete(row.outbox_id, 'sent', provider.id, providerMessageId, null), 3, sleep);
        counts.sent += 1;
      } catch {
        counts.unrecorded += 1; // sent, but not yet recorded: never marked failed (no duplicate message)
      }
    }
  }
  return counts;
}
