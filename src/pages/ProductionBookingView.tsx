import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useOnboarding } from '../context/OnboardingContext';
import { bookableOrganizations } from '../lib/companyService';
import { DataServiceError, newRequestKey } from '../lib/dataService';
import {
  createBooking, listOpenSailings, validateBookingInput,
  type BookingField, type BookingInput, type CreateBookingResult, type Sailing,
} from '../lib/bookingService';
import { MINIMUM_TICKETS_PER_SAILING } from '../domain/rules';
import { ProdPageHeader, SailingTime, dataErrorKey } from '../components/ProductionUi';

/**
 * Production booking (`/book` when VITE_APP_MODE=production).
 *
 * Every step reads or writes Supabase: open sailings are listed from the `sailings` table and
 * the reservation is created only by the `create_booking` RPC. Nothing here shows a price or a
 * payment result — fares, VAT and payment are not connected (pending ATCO decisions). The
 * page is available only to active members of an ATCO-approved company; the database enforces
 * the same rule independently.
 */

const KEY_PREFIX = 'gm-booking-attempt:';
const loadKey = (userId: string) => { try { return sessionStorage.getItem(KEY_PREFIX + userId); } catch { return null; } };
const saveKey = (userId: string, key: string) => { try { sessionStorage.setItem(KEY_PREFIX + userId, key); } catch { /* memory only */ } };
const clearKey = (userId: string) => { try { sessionStorage.removeItem(KEY_PREFIX + userId); } catch { /* storage unavailable */ } };

const seatsLeft = (s: Sailing) => Math.max(0, s.seatCapacity - s.seatsBooked);
const routeLabel = (s: { origin: string; destination: string }) => `${s.origin} → ${s.destination}`;

function SailingOption({ sailing, name, checked, onSelect }: { sailing: Sailing; name: string; checked: boolean; onSelect: () => void }) {
  const { t } = useLanguage();
  const left = seatsLeft(sailing);
  const met = sailing.seatsBooked >= MINIMUM_TICKETS_PER_SAILING;
  const id = `${name}-${sailing.id}`;
  return (
    <label htmlFor={id} className={`sailing-option${checked ? ' selected' : ''}${left === 0 ? ' disabled' : ''}`}>
      <input id={id} type="radio" name={name} checked={checked} disabled={left === 0} onChange={onSelect}
        style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }} />
      <span className={`radio${checked ? ' on' : ''}`} aria-hidden="true" />
      <span className="time-cell"><SailingTime iso={sailing.departsAt} /></span>
      <span className="route-cell"><span className="route-small">{routeLabel(sailing.route)}</span><br /><span className="route-small">{sailing.vessel.name}</span></span>
      <span className="capacity-cell">
        <span className={`pill ${left === 0 ? 'pill-red' : 'pill-green'}`}>{left === 0 ? t('pbFull') : t('pbSeatsLeft').replace('{n}', String(left))}</span>
      </span>
      <span className="fare-cell">
        <span className={`pill ${met ? 'pill-green' : 'pill-gold'}`}>
          {met ? t('pbMinimumMet') : t('pbMinimumCollecting').replace('{n}', String(sailing.seatsBooked)).replace('{min}', String(MINIMUM_TICKETS_PER_SAILING))}
        </span>
      </span>
    </label>
  );
}

export default function ProductionBookingView() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { status } = useOnboarding();
  const userId = user?.id ?? '';
  const organizations = useMemo(() => (status.phase === 'ready' ? bookableOrganizations(status.snapshot) : []), [status]);

  const [sailings, setSailings] = useState<Sailing[] | null>(null);
  const [loadError, setLoadError] = useState<string>('');
  const [form, setForm] = useState({
    organizationId: '', routeId: '', outboundSailingId: '', addReturn: false, returnSailingId: '',
    passengerCount: '1', contactName: user?.fullName ?? '', contactEmail: user?.email ?? '', contactPhone: '',
    extraNames: '', poReference: '',
  });
  const [errors, setErrors] = useState<Partial<Record<BookingField, string>>>({});
  const [failure, setFailure] = useState<DataServiceError | null>(null);
  const [result, setResult] = useState<CreateBookingResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const attemptKey = useRef<string | null>(userId ? loadKey(userId) : null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setSailings(await listOpenSailings());
    } catch (error) {
      setSailings(null);
      setLoadError(dataErrorKey(error));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (organizations.length === 1 && !form.organizationId) setForm(f => ({ ...f, organizationId: organizations[0].id }));
  }, [organizations, form.organizationId]);

  const routes = useMemo(() => {
    const map = new Map<string, Sailing['route']>();
    for (const sailing of sailings ?? []) map.set(sailing.route.id, sailing.route);
    return [...map.values()];
  }, [sailings]);
  const outboundOptions = (sailings ?? []).filter(s => s.route.id === form.routeId);
  const outbound = (sailings ?? []).find(s => s.id === form.outboundSailingId) ?? null;
  const returnOptions = outbound ? (sailings ?? []).filter(s =>
    s.route.origin.trim().toLowerCase() === outbound.route.destination.trim().toLowerCase()
    && s.route.destination.trim().toLowerCase() === outbound.route.origin.trim().toLowerCase()
    && Date.parse(s.departsAt) > Date.parse(outbound.departsAt)) : [];
  const returnSailing = form.addReturn ? returnOptions.find(s => s.id === form.returnSailingId) ?? null : null;
  const maxSeats = Math.min(outbound ? seatsLeft(outbound) : 0, returnSailing ? seatsLeft(returnSailing) : Number.POSITIVE_INFINITY);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm(f => ({ ...f, [key]: value }));
    setErrors({});
  };

  const input = (): BookingInput => ({
    organizationId: form.organizationId,
    outboundSailingId: form.outboundSailingId,
    returnSailingId: form.addReturn ? form.returnSailingId || null : null,
    passengerCount: Number(form.passengerCount),
    contactName: form.contactName,
    contactEmail: form.contactEmail,
    contactPhone: form.contactPhone,
    extraPassengerNames: form.extraNames.split('\n'),
    poReference: form.poReference,
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current || !userId) return;
    const value = input();
    const found = validateBookingInput(value, Number.isFinite(maxSeats) ? maxSeats : undefined);
    if (form.addReturn && !value.returnSailingId) found.returnSailingId = 'required';
    if (Object.keys(found).length > 0) { setErrors(found); return; }
    inFlight.current = true;
    setSubmitting(true);
    setFailure(null);
    const key = attemptKey.current ?? newRequestKey();
    attemptKey.current = key;
    saveKey(userId, key);
    try {
      const created = await createBooking(value, key);
      clearKey(userId);
      attemptKey.current = null;
      setResult(created);
      void load(); // refresh remaining seats from the server
    } catch (error) {
      const err = error instanceof DataServiceError ? error : new DataServiceError('unknown');
      // A definite refusal stored nothing under this key, but a *changed* request must not
      // collide with it either: start a fresh attempt for anything other than an uncertain result.
      if (!err.uncertain) { clearKey(userId); attemptKey.current = null; }
      if (err.kind === 'sailing-full' || err.kind === 'sailing-unavailable') void load();
      setFailure(err);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const fieldError = (field: BookingField) => {
    const err = errors[field];
    if (!err) return null;
    const key = err === 'required' ? 'errFieldRequired' : err === 'invalid-email' ? 'errEmail' : err === 'invalid-phone' ? 'errPhone'
      : err === 'too-many' ? 'pbErrTooMany' : err === 'too-long' ? 'pbErrTooLong' : 'pbErrInvalid';
    return <span className="error" role="alert">{t(key)}</span>;
  };

  const header = <ProdPageHeader titleKey="pbTitle" subKey="pbSub" />;

  if (status.phase !== 'ready') {
    return <>{header}<div className="card card-pad" role="status">{status.phase === 'error' ? t('onbLoadError') : t('onbLoading')}</div></>;
  }
  if (organizations.length === 0) {
    return (
      <>
        {header}
        <section className="card card-pad">
          <h2 className="card-title">{t('pbNotEligibleTitle')}</h2>
          <div className="notice warn" style={{ marginTop: 12 }}>{t('pbNotEligibleBody')}</div>
          <div style={{ marginTop: 14 }}><Link className="btn btn-outline" to="/onboarding">{t('prodStatusLink')}</Link></div>
        </section>
      </>
    );
  }

  if (result) {
    return (
      <>
        {header}
        <section className="card card-pad" aria-labelledby="pb-done">
          <h2 id="pb-done" className="card-title">{t('pbDoneTitle')}</h2>
          <div className="notice" role="status" style={{ marginTop: 12 }}>
            <strong>{t('pbReference')}: <span className="mono">{result.reference}</span></strong>
            {result.outcome === 'replayed' ? t('pbDoneReplayed') : t('pbDoneBody')}
          </div>
          <div className="notice warn" style={{ marginTop: 12 }}>{t('pbNotPaidNotice')}</div>
          <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
            <Link className="btn btn-primary" to={`/bookings/${result.reference}`}>{t('pbViewBooking')}</Link>
            <button type="button" className="btn btn-outline" onClick={() => { setResult(null); setForm(f => ({ ...f, outboundSailingId: '', returnSailingId: '', addReturn: false, extraNames: '', poReference: '' })); }}>{t('pbBookAnother')}</button>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      {header}
      <form className="grid" onSubmit={submit} noValidate aria-busy={submitting}>
        <div className="notice warn">{t('pbNotPaidNotice')}</div>
        {failure && (
          <div className={`notice ${failure.uncertain ? 'warn' : 'danger'}`} role="alert">
            {failure.uncertain && <strong>{t('pbUncertainTitle')}</strong>}
            {t(failure.uncertain ? 'pbUncertainBody' : dataErrorKey(failure))}
          </div>
        )}
        <fieldset disabled={submitting} className="grid" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <section className="card card-pad" aria-labelledby="pb-journey">
            <h2 id="pb-journey" className="card-title">{t('pbJourneyTitle')}</h2>
            <div className="form-grid" style={{ marginTop: 14 }}>
              {organizations.length > 1 && (
                <div className="field">
                  <label htmlFor="pb-org">{t('pbOrganization')} *</label>
                  <select id="pb-org" value={form.organizationId} onChange={e => set('organizationId', e.target.value)}>
                    <option value="">{t('pbChoose')}</option>
                    {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  {fieldError('organizationId')}
                </div>
              )}
              <div className="field">
                <label htmlFor="pb-route">{t('pbRoute')} *</label>
                <select id="pb-route" value={form.routeId}
                  onChange={e => { setForm(f => ({ ...f, routeId: e.target.value, outboundSailingId: '', returnSailingId: '' })); setErrors({}); }}>
                  <option value="">{t('pbChoose')}</option>
                  {routes.map(r => <option key={r.id} value={r.id}>{routeLabel(r)}</option>)}
                </select>
              </div>
            </div>
            {sailings === null && !loadError && <div className="card-desc" role="status" style={{ marginTop: 12 }}>{t('pbLoadingSailings')}</div>}
            {loadError && (
              <div className="notice danger" role="alert" style={{ marginTop: 12 }}>
                {t(loadError)} <button type="button" className="link-btn" onClick={() => void load()}>{t('screenErrorRetry')}</button>
              </div>
            )}
            {sailings !== null && sailings.length === 0 && <div className="no-data" style={{ marginTop: 12 }}>{t('pbNoSailings')}</div>}
            {form.routeId && (
              <div style={{ marginTop: 14 }} role="radiogroup" aria-label={t('pbOutbound')}>
                <strong className="card-title">{t('pbOutbound')} *</strong>
                <div style={{ marginTop: 9 }}>
                  {outboundOptions.map(s => (
                    <SailingOption key={s.id} sailing={s} name="pb-outbound" checked={form.outboundSailingId === s.id}
                      onSelect={() => { setForm(f => ({ ...f, outboundSailingId: s.id, returnSailingId: '' })); setErrors({}); }} />
                  ))}
                </div>
                {fieldError('outboundSailingId')}
              </div>
            )}
            {outbound && (
              <div style={{ marginTop: 10 }}>
                <label className="checkrow"><input type="checkbox" checked={form.addReturn}
                  onChange={e => set('addReturn', e.target.checked)} /><span>{t('pbAddReturn')}</span></label>
                {form.addReturn && (
                  <div style={{ marginTop: 9 }} role="radiogroup" aria-label={t('pbReturn')}>
                    {returnOptions.length === 0 && <div className="no-data">{t('pbNoReturn')}</div>}
                    {returnOptions.map(s => (
                      <SailingOption key={s.id} sailing={s} name="pb-return" checked={form.returnSailingId === s.id}
                        onSelect={() => set('returnSailingId', s.id)} />
                    ))}
                    {fieldError('returnSailingId')}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="card card-pad" aria-labelledby="pb-people">
            <h2 id="pb-people" className="card-title">{t('pbPassengersTitle')}</h2>
            <p className="card-desc">{t('pbPassengersSub')}</p>
            <div className="form-grid" style={{ marginTop: 14 }}>
              <div className="field">
                <label htmlFor="pb-count">{t('pbPassengerCount')} *</label>
                <input id="pb-count" type="number" inputMode="numeric" min={1} max={Number.isFinite(maxSeats) && maxSeats > 0 ? maxSeats : undefined}
                  value={form.passengerCount} onChange={e => set('passengerCount', e.target.value)} aria-invalid={errors.passengerCount ? true : undefined} />
                {fieldError('passengerCount')}
              </div>
              <div className="field">
                <label htmlFor="pb-lead">{t('pbLeadName')} *</label>
                <input id="pb-lead" autoComplete="name" maxLength={120} value={form.contactName} onChange={e => set('contactName', e.target.value)}
                  aria-invalid={errors.contactName ? true : undefined} />
                {fieldError('contactName')}
              </div>
              <div className="field">
                <label htmlFor="pb-email">{t('pbContactEmail')} *</label>
                <input id="pb-email" type="email" dir="ltr" autoComplete="email" value={form.contactEmail} onChange={e => set('contactEmail', e.target.value)}
                  aria-invalid={errors.contactEmail ? true : undefined} />
                {fieldError('contactEmail')}
              </div>
              <div className="field">
                <label htmlFor="pb-phone">{t('pbContactPhone')} *</label>
                <input id="pb-phone" type="tel" dir="ltr" autoComplete="tel" maxLength={20} value={form.contactPhone} onChange={e => set('contactPhone', e.target.value)}
                  aria-invalid={errors.contactPhone ? true : undefined} />
                {fieldError('contactPhone')}
              </div>
              <div className="field">
                <label htmlFor="pb-extra">{t('pbExtraNames')}</label>
                <textarea id="pb-extra" value={form.extraNames} onChange={e => set('extraNames', e.target.value)} />
                <small>{t('pbExtraNamesHint')}</small>
                {fieldError('extraPassengerNames')}
              </div>
              <div className="field">
                <label htmlFor="pb-po">{t('pbPo')}</label>
                <input id="pb-po" maxLength={64} value={form.poReference} onChange={e => set('poReference', e.target.value)} />
                {fieldError('poReference')}
              </div>
            </div>
            <div className="notice blue" style={{ marginTop: 14 }}>{t('pbNotClearance')}</div>
          </section>
        </fieldset>
        <div>
          <button type="submit" className="btn btn-primary" disabled={submitting} aria-busy={submitting}>
            {submitting ? t('pbSubmitting') : failure?.uncertain ? t('pbRetry') : t('pbSubmit')}
          </button>
        </div>
      </form>
    </>
  );
}
