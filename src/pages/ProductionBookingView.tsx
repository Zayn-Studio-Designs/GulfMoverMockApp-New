import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useOnboarding } from '../context/OnboardingContext';
import { bookableOrganizations } from '../lib/companyService';
import { DataServiceError, newRequestKey } from '../lib/dataService';
import { listOpenSailings, type Sailing } from '../lib/bookingService';
import {
  createBookingV2, currentBookingTerms, organizationCommercial, quoteFare,
  type BookingCreated, type BookingTerms, type FareQuote, type OrgCommercial,
} from '../lib/phase8Service';
import { formatSar } from '../domain/money';
import { ProdPageHeader, SailingTime, dataErrorKey } from '../components/ProductionUi';

/**
 * Production booking (`/book`).
 *
 * Who can book (enforced by the database, mirrored here):
 *  - any signed-in person as an INDIVIDUAL — no company registration needed;
 *  - active admins/bookers of an ATCO-approved CORPORATE account, paying now or on
 *    account when Finance has activated a credit facility;
 *  - active admins/bookers of an approved SHIP AGENT, recording the client.
 * Outbound and return are separate sailings, tickets and capacity in one checkout.
 * The fare is quoted by the server from the approved tariff; the browser never sends
 * an amount. A reservation is not paid, cleared for port entry or boarded.
 */

const KEY_PREFIX = 'gm-booking-attempt-v2:';
const loadKey = (userId: string) => { try { return sessionStorage.getItem(KEY_PREFIX + userId); } catch { return null; } };
const saveKey = (userId: string, key: string) => { try { sessionStorage.setItem(KEY_PREFIX + userId, key); } catch { /* memory only */ } };
const clearKey = (userId: string) => { try { sessionStorage.removeItem(KEY_PREFIX + userId); } catch { /* storage unavailable */ } };

const seatsLeft = (s: Sailing) => Math.max(0, s.seatCapacity - s.seatsBooked);
const routeLabel = (s: { origin: string; destination: string }) => `${s.origin} → ${s.destination}`;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9 ()-]{7,20}$/;
const IMO = /^IMO[0-9]{7}$/;

type Field = 'account' | 'outbound' | 'return' | 'count' | 'name' | 'email' | 'phone' | 'extra' | 'po' | 'client' | 'imo' | 'terms';

function SailingOption({ sailing, name, checked, onSelect }: { sailing: Sailing; name: string; checked: boolean; onSelect: () => void }) {
  const { t } = useLanguage();
  const left = seatsLeft(sailing);
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
    </label>
  );
}

export default function ProductionBookingView() {
  const { t, lang } = useLanguage();
  const { user } = useAuth();
  const { status } = useOnboarding();
  const userId = user?.id ?? '';
  const organizations = useMemo(() => (status.phase === 'ready' ? bookableOrganizations(status.snapshot) : []), [status]);
  const suspended = status.phase === 'ready' && status.snapshot.profile?.status === 'suspended';

  const [sailings, setSailings] = useState<Sailing[] | null>(null);
  const [orgInfo, setOrgInfo] = useState<OrgCommercial[]>([]);
  const [terms, setTerms] = useState<BookingTerms | null>(null);
  const [loadError, setLoadError] = useState('');
  const [quote, setQuote] = useState<FareQuote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [form, setForm] = useState({
    account: 'individual', settlement: 'pay_now' as 'pay_now' | 'on_account', routeId: '', outboundSailingId: '', addReturn: false, returnSailingId: '',
    passengerCount: '1', contactName: user?.fullName ?? '', contactEmail: user?.email ?? '', contactPhone: '',
    extraNames: '', poReference: '', clientName: '', clientReference: '', destinationVessel: '', destinationImo: '', acceptTerms: false,
  });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<DataServiceError | null>(null);
  const [result, setResult] = useState<BookingCreated | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const attemptKey = useRef<string | null>(userId ? loadKey(userId) : null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [list, current] = await Promise.all([listOpenSailings(), currentBookingTerms()]);
      setSailings(list); setTerms(current);
    } catch (error) {
      setSailings(null);
      setLoadError(dataErrorKey(error));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const ids = organizations.map(o => o.id);
    if (ids.length === 0) return;
    organizationCommercial(ids).then(setOrgInfo).catch(() => setOrgInfo([]));
  }, [organizations]);

  const selectedOrg = organizations.find(o => o.id === form.account) ?? null;
  const selectedInfo = orgInfo.find(o => o.id === form.account) ?? null;
  const isAgent = selectedInfo?.accountType === 'agent';
  const creditActive = selectedInfo?.creditStatus === 'active';

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
  const count = Number(form.passengerCount);

  // Server-side quote whenever the journey changes (never computed in the browser).
  useEffect(() => {
    setQuote(null); setQuoteError('');
    if (!outbound || !Number.isInteger(count) || count < 1 || count > 1000 || (form.addReturn && !returnSailing)) return;
    let live = true;
    quoteFare(outbound.id, returnSailing?.id ?? null, count)
      .then(q => { if (live) setQuote(q); })
      .catch(e => { if (live) setQuoteError(dataErrorKey(e)); });
    return () => { live = false; };
  }, [outbound?.id, returnSailing?.id, count, form.addReturn]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => { setForm(f => ({ ...f, [key]: value })); setErrors({}); };

  const validate = (): Partial<Record<Field, string>> => {
    const e: Partial<Record<Field, string>> = {};
    if (form.account !== 'individual' && !selectedOrg) e.account = 'errFieldRequired';
    if (!form.outboundSailingId) e.outbound = 'errFieldRequired';
    if (form.addReturn && !form.returnSailingId) e.return = 'errFieldRequired';
    if (!Number.isInteger(count) || count < 1) e.count = 'pbErrInvalid';
    else if (Number.isFinite(maxSeats) && count > maxSeats) e.count = 'pbErrTooMany';
    if (!form.contactName.trim()) e.name = 'errFieldRequired';
    else if (form.contactName.trim().length > 120) e.name = 'pbErrTooLong';
    if (!EMAIL.test(form.contactEmail.trim())) e.email = 'errEmail';
    if (!PHONE.test(form.contactPhone.trim())) e.phone = 'errPhone';
    const extras = form.extraNames.split('\n').map(v => v.trim()).filter(Boolean);
    if (extras.length + 1 > Math.max(count, 1)) e.extra = 'pbErrTooMany';
    if (form.poReference.trim().length > 64) e.po = 'pbErrTooLong';
    if (isAgent && !form.clientName.trim()) e.client = 'errFieldRequired';
    if (form.destinationImo.trim() && !IMO.test(form.destinationImo.trim().toUpperCase())) e.imo = 'p8ErrImo';
    if (!form.acceptTerms) e.terms = 'p8ErrTerms';
    return e;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current || !userId || !terms) return;
    const found = validate();
    if (Object.keys(found).length > 0) { setErrors(found); return; }
    inFlight.current = true; setSubmitting(true); setFailure(null);
    const key = attemptKey.current ?? newRequestKey();
    attemptKey.current = key; saveKey(userId, key);
    try {
      const created = await createBookingV2({
        mode: form.account === 'individual' ? 'individual' : 'organization', organizationId: selectedOrg?.id ?? '',
        settlementMode: form.account !== 'individual' && creditActive ? form.settlement : 'pay_now',
        outboundSailingId: form.outboundSailingId, returnSailingId: form.addReturn ? form.returnSailingId : null, passengerCount: count,
        contactName: form.contactName, contactEmail: form.contactEmail, contactPhone: form.contactPhone, extraPassengerNames: form.extraNames.split('\n'),
        poReference: form.account === 'individual' ? '' : form.poReference, clientName: isAgent ? form.clientName : '', clientReference: isAgent ? form.clientReference : '',
        destinationVessel: form.destinationVessel, destinationImo: form.destinationImo, termsVersion: terms.version,
      }, key);
      clearKey(userId); attemptKey.current = null;
      setResult(created);
      void load();
    } catch (error) {
      const err = error instanceof DataServiceError ? error : new DataServiceError('unknown');
      if (!err.uncertain) { clearKey(userId); attemptKey.current = null; }
      if (err.kind === 'sailing-full' || err.kind === 'sailing-unavailable' || err.kind === 'terms-not-accepted') void load();
      setFailure(err);
    } finally {
      inFlight.current = false; setSubmitting(false);
    }
  };

  const fieldError = (field: Field) => errors[field] ? <span className="error" role="alert">{t(errors[field]!)}</span> : null;
  const header = <ProdPageHeader titleKey="pbTitle" subKey="p8BookSub" />;

  if (status.phase !== 'ready') {
    return <>{header}<div className="card card-pad" role="status">{status.phase === 'error' ? t('onbLoadError') : t('onbLoading')}</div></>;
  }
  if (suspended) {
    return <>{header}<div className="card card-pad"><div className="notice danger" role="alert">{t('onbSuspendedBody')}</div></div></>;
  }

  if (result) {
    return (
      <>
        {header}
        <section className="card card-pad" aria-labelledby="pb-done">
          <h2 id="pb-done" className="card-title">{t('pbDoneTitle')}</h2>
          <div className="notice" role="status" style={{ marginTop: 12 }}>
            <strong>{t('pbReference')}: <span className="mono">{result.reference}</span></strong>{' '}
            {result.outcome === 'replayed' ? t('pbDoneReplayed') : t('p8DoneBody')}
          </div>
          <div className="notice warn" style={{ marginTop: 12 }}>{t('p8NotClearedNotice')}</div>
          <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
            <Link className="btn btn-primary" to={`/bookings/${result.reference}`}>{t('p8ContinueToPayment')}</Link>
            <button type="button" className="btn btn-outline" onClick={() => { setResult(null); setForm(f => ({ ...f, outboundSailingId: '', returnSailingId: '', addReturn: false, extraNames: '', poReference: '', clientName: '', clientReference: '', acceptTerms: false })); }}>{t('pbBookAnother')}</button>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      {header}
      <form className="grid" onSubmit={submit} noValidate aria-busy={submitting}>
        {failure && (
          <div className={`notice ${failure.uncertain ? 'warn' : 'danger'}`} role="alert">
            {failure.uncertain && <strong>{t('pbUncertainTitle')} </strong>}
            {t(failure.uncertain ? 'pbUncertainBody' : dataErrorKey(failure))}
          </div>
        )}
        <fieldset disabled={submitting} className="grid" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <section className="card card-pad" aria-labelledby="pb-account">
            <h2 id="pb-account" className="card-title">{t('p8BookAsTitle')}</h2>
            <div className="form-grid" style={{ marginTop: 14 }}>
              <div className="field">
                <label htmlFor="pb-account-select">{t('p8BookAs')} *</label>
                <select id="pb-account-select" value={form.account} onChange={e => { set('account', e.target.value); set('settlement', 'pay_now'); }}>
                  <option value="individual">{t('p8AccountIndividual')}</option>
                  {organizations.map(o => {
                    const info = orgInfo.find(i => i.id === o.id);
                    return <option key={o.id} value={o.id}>{o.name} · {t(info?.accountType === 'agent' ? 'p8AccountAgent' : 'p8AccountCorporate')}</option>;
                  })}
                </select>
                <small>{form.account === 'individual' ? t('p8IndividualHint') : isAgent ? t('p8AgentHint') : t('p8CorporateHint')}</small>
                {fieldError('account')}
              </div>
              {form.account !== 'individual' && (
                <div className="field">
                  <label htmlFor="pb-settlement">{t('p8Settlement')}</label>
                  <select id="pb-settlement" value={creditActive ? form.settlement : 'pay_now'} disabled={!creditActive}
                    onChange={e => set('settlement', e.target.value as 'pay_now' | 'on_account')}>
                    <option value="pay_now">{t('p8PayNow')}</option>
                    {creditActive && <option value="on_account">{t('p8OnAccount')}</option>}
                  </select>
                  <small>{creditActive ? t('p8OnAccountHint') : t('p8NoCreditHint')}</small>
                </div>
              )}
            </div>
            {organizations.length === 0 && (
              <p className="card-desc" style={{ marginTop: 10 }}>{t('p8CompanyOptional')} <Link to="/onboarding" className="link-btn">{t('p8RegisterCompany')}</Link></p>
            )}
          </section>

          <section className="card card-pad" aria-labelledby="pb-journey">
            <h2 id="pb-journey" className="card-title">{t('pbJourneyTitle')}</h2>
            <div className="form-grid" style={{ marginTop: 14 }}>
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
            {loadError && <div className="notice danger" role="alert" style={{ marginTop: 12 }}>{t(loadError)} <button type="button" className="link-btn" onClick={() => void load()}>{t('screenErrorRetry')}</button></div>}
            {sailings !== null && sailings.length === 0 && <div className="no-data" style={{ marginTop: 12 }}>{t('pbNoSailings')}</div>}
            {form.routeId && (
              <div style={{ marginTop: 14 }} role="radiogroup" aria-label={t('pbOutbound')}>
                <strong className="card-title">{t('pbOutbound')} *</strong>
                <p className="card-desc">{t('p8TimesRiyadh')}</p>
                <div style={{ marginTop: 9 }}>
                  {outboundOptions.map(s => (
                    <SailingOption key={s.id} sailing={s} name="pb-outbound" checked={form.outboundSailingId === s.id}
                      onSelect={() => { setForm(f => ({ ...f, outboundSailingId: s.id, returnSailingId: '' })); setErrors({}); }} />
                  ))}
                </div>
                {fieldError('outbound')}
              </div>
            )}
            {outbound && (
              <div style={{ marginTop: 10 }}>
                <label className="checkrow"><input type="checkbox" checked={form.addReturn} onChange={e => set('addReturn', e.target.checked)} /><span>{t('pbAddReturn')}</span></label>
                {form.addReturn && (
                  <div style={{ marginTop: 9 }} role="radiogroup" aria-label={t('pbReturn')}>
                    <p className="card-desc">{t('p8ReturnSeparate')}</p>
                    {returnOptions.length === 0 && <div className="no-data">{t('pbNoReturn')}</div>}
                    {returnOptions.map(s => (
                      <SailingOption key={s.id} sailing={s} name="pb-return" checked={form.returnSailingId === s.id} onSelect={() => set('returnSailingId', s.id)} />
                    ))}
                    {fieldError('return')}
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
                  value={form.passengerCount} onChange={e => set('passengerCount', e.target.value)} aria-invalid={errors.count ? true : undefined} />
                {fieldError('count')}
              </div>
              <div className="field">
                <label htmlFor="pb-lead">{t('pbLeadName')} *</label>
                <input id="pb-lead" autoComplete="name" maxLength={120} value={form.contactName} onChange={e => set('contactName', e.target.value)} aria-invalid={errors.name ? true : undefined} />
                {fieldError('name')}
              </div>
              <div className="field">
                <label htmlFor="pb-email">{t('pbContactEmail')} *</label>
                <input id="pb-email" type="email" dir="ltr" autoComplete="email" value={form.contactEmail} onChange={e => set('contactEmail', e.target.value)} aria-invalid={errors.email ? true : undefined} />
                {fieldError('email')}
              </div>
              <div className="field">
                <label htmlFor="pb-phone">{t('pbContactPhone')} *</label>
                <input id="pb-phone" type="tel" dir="ltr" autoComplete="tel" maxLength={20} value={form.contactPhone} onChange={e => set('contactPhone', e.target.value)} aria-invalid={errors.phone ? true : undefined} />
                {fieldError('phone')}
              </div>
              <div className="field">
                <label htmlFor="pb-extra">{t('pbExtraNames')}</label>
                <textarea id="pb-extra" value={form.extraNames} onChange={e => set('extraNames', e.target.value)} />
                <small>{t('pbExtraNamesHint')}</small>
                {fieldError('extra')}
              </div>
              <div className="field">
                <label htmlFor="pb-vessel">{t('p8DestinationVessel')}</label>
                <input id="pb-vessel" maxLength={120} value={form.destinationVessel} onChange={e => set('destinationVessel', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="pb-imo">{t('p8DestinationImo')}</label>
                <input id="pb-imo" dir="ltr" maxLength={10} placeholder="IMO1234567" value={form.destinationImo} onChange={e => set('destinationImo', e.target.value)} aria-invalid={errors.imo ? true : undefined} />
                {fieldError('imo')}
              </div>
              {form.account !== 'individual' && (
                <div className="field">
                  <label htmlFor="pb-po">{t('pbPo')}</label>
                  <input id="pb-po" maxLength={64} value={form.poReference} onChange={e => set('poReference', e.target.value)} />
                  {fieldError('po')}
                </div>
              )}
              {isAgent && (
                <>
                  <div className="field">
                    <label htmlFor="pb-client">{t('p8ClientName')} *</label>
                    <input id="pb-client" maxLength={120} value={form.clientName} onChange={e => set('clientName', e.target.value)} aria-invalid={errors.client ? true : undefined} />
                    {fieldError('client')}
                  </div>
                  <div className="field">
                    <label htmlFor="pb-client-ref">{t('p8ClientReference')}</label>
                    <input id="pb-client-ref" maxLength={64} value={form.clientReference} onChange={e => set('clientReference', e.target.value)} />
                  </div>
                </>
              )}
            </div>
            <div className="notice blue" style={{ marginTop: 14 }}>{t('pbNotClearance')}</div>
          </section>

          <section className="card card-pad" aria-labelledby="pb-price" aria-live="polite">
            <h2 id="pb-price" className="card-title">{t('p8PriceTitle')}</h2>
            {!quote && !quoteError && <p className="card-desc">{t('p8PriceChoose')}</p>}
            {quoteError && <div className="notice danger" role="alert">{t(quoteError)}</div>}
            {quote && (
              <div className="inset small" style={{ marginTop: 10 }}>
                <div className="between"><span className="muted">{t('p8FarePerLeg')}</span><strong>{formatSar(quote.unitHalala, lang)}</strong></div>
                <div className="between" style={{ marginTop: 6 }}><span className="muted">{t('p8Tickets')}</span><strong>{quote.quantity}</strong></div>
                <div className="between" style={{ marginTop: 6 }}><span className="muted">{t('p8Net')}</span><strong>{formatSar(quote.netHalala, lang)}</strong></div>
                <div className="between" style={{ marginTop: 6 }}><span className="muted">{t('p8Vat')}</span>
                  <strong>{quote.vatMode === 'not_configured' ? t('p8VatNotConfigured') : `${formatSar(quote.vatHalala, lang)} (${(quote.vatRateBp / 100).toFixed(2)}%)`}</strong></div>
                <div className="between" style={{ marginTop: 6 }}><span>{t('p8Total')}</span><strong>{formatSar(quote.totalHalala, lang)}</strong></div>
                {quote.tariffStatus !== 'approved' && <div className="notice warn" style={{ marginTop: 10 }}>{t('p8TariffProvisional')}</div>}
              </div>
            )}
          </section>

          <section className="card card-pad" aria-labelledby="pb-terms">
            <h2 id="pb-terms" className="card-title">{terms ? (lang === 'ar' ? terms.title.ar : terms.title.en) || t('p8TermsTitle') : t('p8TermsTitle')}</h2>
            {terms && <p className="card-desc" style={{ whiteSpace: 'pre-wrap' }}>{lang === 'ar' ? terms.body.ar : terms.body.en}</p>}
            {terms && <p className="card-desc">{t('p8TermsVersion').replace('{v}', terms.version)}{terms.status !== 'approved' ? ` · ${t('p8Provisional')}` : ''}</p>}
            <label className="checkrow" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={form.acceptTerms} onChange={e => set('acceptTerms', e.target.checked)} aria-invalid={errors.terms ? true : undefined} />
              <span>{t('p8AcceptTerms')}</span>
            </label>
            {fieldError('terms')}
          </section>
        </fieldset>
        <div>
          <button type="submit" className="btn btn-primary" disabled={submitting || !terms} aria-busy={submitting}>
            {submitting ? t('pbSubmitting') : failure?.uncertain ? t('pbRetry') : t('p8Reserve')}
          </button>
        </div>
      </form>
    </>
  );
}
