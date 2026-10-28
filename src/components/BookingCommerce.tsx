import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { DataServiceError, newRequestKey } from '../lib/dataService';
import { listOpenSailings, type Booking, type Sailing } from '../lib/bookingService';
import {
  bookingCommercial, bookingEvents, cancelBookingV2, listCreditNotes, listInvoicesForBooking, listPaymentsV2, listRefunds,
  rescheduleLeg, sailingCommercialStatus, sailingGate, simulateSandboxPayment, startCheckout,
  type BookingCommercial, type BookingEvent, type CommercialStatus, type CreditNote, type InvoiceV2, type PaymentMethodV2, type PaymentV2, type Refund,
} from '../lib/phase8Service';
import { formatSar } from '../domain/money';
import { SailingTime, dataErrorKey } from './ProductionUi';

/**
 * Booking detail panels: separate reservation / payment / minimum / operational
 * states, server-quoted price, checkout, documents, refunds and lifecycle actions.
 * Every value shown comes from the database; every action is a validated RPC.
 */

const STATE_TONE: Record<string, string> = {
  reserved: 'pill-gold', pending_payment: 'pill-gold', paid: 'pill-green', cancelled: 'pill-red', refunded: 'pill-neutral', expired: 'pill-red',
  unpaid: 'pill-gold', pending: 'pill-gold', on_account: 'pill-green', partially_refunded: 'pill-neutral',
  threshold_met: 'pill-green', awaiting_minimum: 'pill-gold', below_minimum_after_deadline: 'pill-red', proceed_below_minimum: 'pill-green',
  open: 'pill-green', not_ready: 'pill-neutral', master_not_go: 'pill-neutral', clearance_pending: 'pill-neutral', sailing_suspended: 'pill-red', sailing_cancelled: 'pill-red',
};

function Pill({ value, prefix }: { value: string; prefix: string }) {
  const { t } = useLanguage();
  return <span className={`pill pill-wrap ${STATE_TONE[value] ?? 'pill-neutral'}`}>{t(`${prefix}${value}`)}</span>;
}

function HoldCountdown({ until }: { until: string }) {
  const { t } = useLanguage();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const left = Math.max(0, Date.parse(until) - now);
  const mm = Math.floor(left / 60000); const ss = Math.floor((left % 60000) / 1000);
  return <span className={`pill ${left === 0 ? 'pill-red' : 'pill-gold'}`} role="timer">{left === 0 ? t('p8HoldExpired') : t('p8HoldLeft').replace('{t}', `${mm}:${String(ss).padStart(2, '0')}`)}</span>;
}

export function BookingCommerce({ booking, onChanged }: { booking: Booking; onChanged: () => void }) {
  const { t, lang } = useLanguage();
  const [commercial, setCommercial] = useState<BookingCommercial | null>(null);
  const [legStatus, setLegStatus] = useState<Record<string, { commercial: CommercialStatus | null; gate: string }>>({});
  const [payments, setPayments] = useState<PaymentV2[]>([]);
  const [invoices, setInvoices] = useState<InvoiceV2[]>([]);
  const [credits, setCredits] = useState<CreditNote[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [events, setEvents] = useState<BookingEvent[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<PaymentMethodV2>('mada');
  const checkoutKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [c, p, i, cn, r, ev] = await Promise.all([bookingCommercial(booking.id), listPaymentsV2(booking.id), listInvoicesForBooking(booking.id),
        listCreditNotes(booking.id), listRefunds({ bookingId: booking.id }), bookingEvents(booking.id)]);
      setCommercial(c); setPayments(p); setInvoices(i); setCredits(cn); setRefunds(r); setEvents(ev);
      const entries = await Promise.all(booking.legs.filter(l => l.sailing).map(async l => {
        const [cs, gate] = await Promise.all([sailingCommercialStatus(l.sailing!.id).catch(() => null), sailingGate(l.sailing!.id).catch(() => '')]);
        return [l.leg, { commercial: cs, gate }] as const;
      }));
      setLegStatus(Object.fromEntries(entries));
    } catch (e) { setError(dataErrorKey(e)); }
  }, [booking.id, booking.legs]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); await load(); onChanged(); } catch (e) {
      setError(dataErrorKey(e));
      if (e instanceof DataServiceError && !e.uncertain) checkoutKey.current = null;
    } finally { setBusy(false); }
  };

  if (!commercial) return error ? <div className="notice danger" role="alert">{t(error)}</div> : null;

  const inFlight = payments.find(p => p.status === 'initiated' || p.status === 'pending') ?? null;
  const payable = commercial.settlementMode === 'pay_now' && ['reserved', 'pending_payment'].includes(commercial.status) && ['unpaid', 'pending'].includes(commercial.paymentStatus);
  const closed = ['cancelled', 'expired', 'refunded'].includes(commercial.status);

  const pay = () => act(async () => {
    const key = checkoutKey.current ?? newRequestKey();
    checkoutKey.current = key;
    const started = await startCheckout(booking.id, method, key);
    if (started.checkoutUrl) window.location.assign(started.checkoutUrl);
  });

  return (
    <>
      <section className="card card-pad" aria-labelledby="bc-status">
        <h2 id="bc-status" className="card-title">{t('p8StatusTitle')}</h2>
        {error && <div className="notice danger" role="alert" style={{ marginTop: 10 }}>{t(error)}</div>}
        <div className="status-grid" style={{ marginTop: 14 }}>
          <div className="status-item"><div className="status-label">{t('pbStatusReservation')}</div><div className="status-text"><Pill value={commercial.status} prefix="p8Bk_" /></div></div>
          <div className="status-item"><div className="status-label">{t('pbStatusPayment')}</div><div className="status-text"><Pill value={commercial.paymentStatus} prefix="p8Pay_" /></div></div>
          {booking.legs.map(l => (
            <div key={l.leg} className="status-item">
              <div className="status-label">{t(l.leg === 'return' ? 'pbReturn' : 'pbOutbound')} · {t('p8Minimum')}</div>
              <div className="status-text">{legStatus[l.leg]?.commercial ? <Pill value={legStatus[l.leg]!.commercial!.state} prefix="p8Min_" /> : '—'}</div>
              {legStatus[l.leg]?.commercial && <div className="muted small">{t('p8MinProgress').replace('{q}', String(legStatus[l.leg]!.commercial!.qualifyingTickets)).replace('{min}', String(legStatus[l.leg]!.commercial!.thresholdTickets))}</div>}
            </div>
          ))}
          {booking.legs.map(l => (
            <div key={`${l.leg}-gate`} className="status-item">
              <div className="status-label">{t(l.leg === 'return' ? 'pbReturn' : 'pbOutbound')} · {t('p8Operational')}</div>
              <div className="status-text">{legStatus[l.leg]?.gate ? <Pill value={legStatus[l.leg]!.gate} prefix="p8Gate_" /> : '—'}</div>
            </div>
          ))}
        </div>
        <div className="notice blue" style={{ marginTop: 12 }}>{t('p8StatesSeparate')}</div>
        {commercial.paymentStatus === 'paid' && payments.length > 0 && payments.every(p => p.mode === 'sandbox') && (
          <div className="notice warn" role="note" style={{ marginTop: 10 }}><strong>{t('p8SandboxPaidNotice')}</strong></div>
        )}
      </section>

      <section className="card card-pad" aria-labelledby="bc-price">
        <h2 id="bc-price" className="card-title">{t('p8PriceTitle')}</h2>
        <div className="inset small" style={{ marginTop: 10 }}>
          <div className="between"><span className="muted">{t('p8Net')}</span><strong>{formatSar(commercial.netHalala, lang)}</strong></div>
          <div className="between"><span className="muted">{t('p8Vat')}</span><strong>{commercial.vatMode === 'not_configured' ? t('p8VatNotConfigured') : formatSar(commercial.vatHalala, lang)}</strong></div>
          <div className="between"><span>{t('p8Total')}</span><strong>{formatSar(commercial.totalHalala, lang)}</strong></div>
          {commercial.clientName && <div className="between"><span className="muted">{t('p8ClientName')}</span><strong>{commercial.clientName}</strong></div>}
          {commercial.termsVersion && <div className="between"><span className="muted">{t('p8TermsAccepted')}</span><strong className="mono">{commercial.termsVersion}</strong></div>}
        </div>
        {commercial.tariffStatus !== 'approved' && <div className="notice warn" style={{ marginTop: 10 }}>{t('p8TariffProvisional')}</div>}
      </section>

      {payable && (
        <section className="card card-pad" aria-labelledby="bc-pay">
          <div className="between"><h2 id="bc-pay" className="card-title">{t('p8PayTitle')}</h2>{commercial.holdExpiresAt && <HoldCountdown until={commercial.holdExpiresAt} />}</div>
          <p className="card-desc">{t('p8PayBody')}</p>
          {!inFlight && (
            <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <label className="sr-only" htmlFor="bc-method">{t('p8Method')}</label>
              <select id="bc-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethodV2)}>
                <option value="mada">mada</option><option value="visa">Visa</option><option value="mastercard">Mastercard</option><option value="apple_pay">Apple Pay</option>
              </select>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void pay()}>{t('p8PayCta').replace('{amount}', formatSar(commercial.totalHalala, lang))}</button>
            </div>
          )}
          {inFlight && (
            <div className="inset small" style={{ marginTop: 12 }}>
              <div className="between"><span>{t('p8PaymentInFlight')}</span><span className="pill pill-gold">{t(`p8PStatus_${inFlight.status}`)}</span></div>
              {inFlight.mode === 'sandbox' && (
                <>
                  <div className="notice warn" style={{ marginTop: 10 }}><strong>{t('p8SandboxCheckoutTitle')}</strong> {t('p8SandboxCheckoutBody')}</div>
                  <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(() => simulateSandboxPayment(inFlight.id, 'paid'))}>{t('p8SimulateSuccess')}</button>
                    <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void act(() => simulateSandboxPayment(inFlight.id, 'failed'))}>{t('p8SimulateFailure')}</button>
                  </div>
                </>
              )}
              <button type="button" className="link-btn" style={{ marginTop: 8 }} onClick={() => void load()}>{t('p8CheckStatus')}</button>
            </div>
          )}
          <p className="muted small" style={{ marginTop: 10 }}>{t('p8NoCardData')}</p>
        </section>
      )}

      {(payments.length > 0 || invoices.length > 0 || credits.length > 0 || refunds.length > 0) && (
        <section className="card card-pad" aria-labelledby="bc-docs">
          <h2 id="bc-docs" className="card-title">{t('p8DocumentsTitle')}</h2>
          {invoices.map(i => (
            <div key={i.id} className="request-row">
              <div><div className="request-title mono">{i.invoiceNumber}</div><div className="request-meta">{t(i.documentType === 'commercial_invoice' ? 'p8DocCommercial' : i.documentType === 'tax_invoice' ? 'p8DocTax' : 'p8DocSimplified')} · {formatSar(i.totalHalala, lang)}{i.sandbox ? ` · ${t('p8Sandbox')}` : ''}</div></div>
              <div className="row"><span className="pill pill-neutral">{t(`p8Inv_${i.status}`)}</span><Link className="btn btn-outline btn-small" to={`/invoices/${i.id}`}>{t('p8ViewDocument')}</Link></div>
            </div>
          ))}
          {payments.map(p => (
            <div key={p.id} className="request-row">
              <div><div className="request-title">{t('p8Receipt')} · <span className="mono">{p.providerRef ?? '—'}</span></div>
                <div className="request-meta">{p.method} · {formatSar(p.amountHalala, lang)}{p.refundedHalala ? ` · ${t('p8Refunded')} ${formatSar(p.refundedHalala, lang)}` : ''}{p.mode === 'sandbox' ? ` · ${t('p8Sandbox')}` : ''}</div></div>
              <span className="pill pill-neutral">{t(`p8PStatus_${p.status}`)}</span>
            </div>
          ))}
          {credits.map(c => (
            <div key={c.id} className="request-row">
              <div><div className="request-title mono">{c.creditNumber}</div><div className="request-meta">{t('p8CreditNote')} · {formatSar(c.totalHalala, lang)} · {c.reason}</div></div>
            </div>
          ))}
          {refunds.map(r => (
            <div key={r.id} className="request-row">
              <div><div className="request-title">{t('p8Refund')} · {formatSar(r.amountHalala, lang)}</div><div className="request-meta">{r.reason}</div></div>
              <span className="pill pill-neutral">{t(`p8Rf_${r.status}`)}</span>
            </div>
          ))}
        </section>
      )}

      {!closed && <ManageBooking booking={booking} commercial={commercial} busy={busy} act={act} />}

      {events.length > 0 && (
        <section className="card card-pad" aria-labelledby="bc-history">
          <h2 id="bc-history" className="card-title">{t('p8HistoryTitle')}</h2>
          <ol className="small" style={{ marginTop: 10, paddingInlineStart: 18 }}>
            {events.map((e, i) => <li key={i}><span className="mono">{new Date(e.createdAt).toLocaleString(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { timeZone: 'Asia/Riyadh' })}</span> · {t(`p8Ev_${e.action}`)}</li>)}
          </ol>
        </section>
      )}
    </>
  );
}

function ManageBooking({ booking, commercial, busy, act }: { booking: Booking; commercial: BookingCommercial; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useLanguage();
  const [reason, setReason] = useState('');
  const [leg, setLeg] = useState<'outbound' | 'return'>('outbound');
  const [options, setOptions] = useState<Sailing[]>([]);
  const [target, setTarget] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const current = booking.legs.find(l => l.leg === leg)?.sailing ?? null;

  useEffect(() => {
    listOpenSailings().then(all => setOptions(all.filter(s => current && s.id !== current.id
      && s.route.origin === current.origin && s.route.destination === current.destination))).catch(() => setOptions([]));
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card card-pad" aria-labelledby="bc-manage">
      <h2 id="bc-manage" className="card-title">{t('p8ManageTitle')}</h2>
      <p className="card-desc">{t('p8ManageBody')}</p>
      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="bc-reason">{t('p8Reason')} *</label>
        <input id="bc-reason" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
      </div>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <div className="field">
          <label htmlFor="bc-leg">{t('p8RescheduleLeg')}</label>
          <select id="bc-leg" value={leg} onChange={e => { setLeg(e.target.value as 'outbound' | 'return'); setTarget(''); }}>
            {booking.legs.map(l => <option key={l.leg} value={l.leg}>{t(l.leg === 'return' ? 'pbReturn' : 'pbOutbound')}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bc-target">{t('p8NewSailing')}</label>
          <select id="bc-target" value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">{t('pbChoose')}</option>
            {options.map(s => <option key={s.id} value={s.id}>{new Date(s.departsAt).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' })} ({Math.max(0, s.seatCapacity - s.seatsBooked)})</option>)}
          </select>
          {current && <small>{t('p8CurrentSailing')}: <SailingTime iso={current.departsAt} /></small>}
        </div>
      </div>
      <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-outline" disabled={busy || !target || !reason.trim()} onClick={() => void act(() => rescheduleLeg(booking.id, leg, target, reason))}>{t('p8Reschedule')}</button>
        {!confirmCancel
          ? <button type="button" className="btn btn-outline" disabled={busy || !reason.trim()} onClick={() => setConfirmCancel(true)}>{t('p8CancelBooking')}</button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(() => cancelBookingV2(booking.id, reason))}>{t('p8ConfirmCancel')}</button>}
      </div>
      {confirmCancel && <div className="notice warn" style={{ marginTop: 10 }}>{commercial.paymentStatus === 'paid' ? t('p8CancelPaidNotice') : t('p8CancelUnpaidNotice')}</div>}
    </section>
  );
}
