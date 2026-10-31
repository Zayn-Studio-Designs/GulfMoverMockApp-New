import { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { usePlatformRoles } from '../context/OnboardingContext';
import {
  cancelSailing, decideSailingMinimum, expireStaleHolds, generateSailings, listSailingControl, listScheduleTemplates,
  recordMasterDecision, recordNoShows, recordPortClearance, resumeSailing, sailingControlStatus,
  setSailingReadiness, suspendSailing, type CommercialStatus, type SailingControl, type SailingStatus,
} from '../lib/phase8Service';
import { formatSar } from '../domain/money';
import { ProdPageHeader, SailingTime } from '../components/ProductionUi';
import { FlashNotice, ReasonField, RequireRoles, todayRiyadh, useAction, useLoad } from '../components/StaffKit';

/**
 * Sailing control (`/admin/sailings`). Commercial threshold, operational readiness,
 * the Master's go/no-go and port clearance are SEPARATE checkpoints recorded with
 * who/when/why; reaching the minimum never clears a sailing. Cancelling a sailing
 * opens refund reviews for Finance — it never refunds automatically.
 */

function SailingCard({ sailing, status, reason, onDone }: { sailing: SailingControl; status: SailingStatus | undefined; reason: string; onDone: () => Promise<void> }) {
  const { t, lang } = useLanguage();
  const roles = usePlatformRoles() ?? [];
  const isOps = roles.includes('super_admin') || roles.includes('operations');
  // Status arrives from the page's single batch request; after an action the page reloads the list and statuses together.
  const { busy, flash, run } = useAction(onDone);
  const [master, setMaster] = useState('');
  const [permit, setPermit] = useState('');
  const c: CommercialStatus | undefined = status?.commercial;
  const departed = Date.parse(sailing.departsAt) <= Date.now();
  const need = !reason.trim();
  return (
    <div className="card card-pad" style={{ marginBottom: 10 }}>
      <div className="between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div className="request-title"><SailingTime iso={sailing.departsAt} /> · {sailing.origin} → {sailing.destination}</div>
          <div className="request-meta">{sailing.vesselName} · {t('p8ColSeatsBooked')} {sailing.seatsBooked}/{sailing.seatCapacity}{sailing.payloadCapacityKg !== null ? ` · ${t('p8Payload')} ${sailing.payloadBookedKg}/${sailing.payloadCapacityKg} kg` : ''}</div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className="pill pill-neutral">{t(`p8Sail_${sailing.status}`)}</span>
          {c && <span className={`pill pill-wrap ${c.thresholdMet ? 'pill-green' : 'pill-gold'}`}>{t(`p8Min_${c.state}`)}</span>}
          {status && <span className="pill pill-wrap pill-neutral">{t(`p8Gate_${status.gate}`)}</span>}
        </div>
      </div>
      {c && <p className="muted small" style={{ marginTop: 6 }}>{t('p8MinDetail').replace('{q}', String(c.qualifyingTickets)).replace('{min}', String(c.thresholdTickets)).replace('{r}', String(c.reservedTickets))
        .replace('{rev}', formatSar(c.qualifyingRevenueHalala, lang)).replace('{minrev}', formatSar(c.thresholdRevenueHalala, lang))}</p>}
      <div className="status-grid" style={{ marginTop: 8 }}>
        <div className="status-item"><div className="status-label">{t('p8Readiness')}</div><div className="status-text">{t(`p4Readiness_${sailing.readinessStatus}`)}</div></div>
        <div className="status-item"><div className="status-label">{t('p8MasterDecision')}</div><div className="status-text">{t(`p8Master_${sailing.masterDecision}`)}</div></div>
        <div className="status-item"><div className="status-label">{t('p8PortClearance')}</div><div className="status-text">{t(`p8Port_${sailing.portClearanceStatus}`)}</div></div>
      </div>
      {isOps && sailing.status !== 'cancelled' && (
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => setSailingReadiness(sailing.id, 'ready', reason))}>{t('p8MarkReady')}</button>
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => setSailingReadiness(sailing.id, 'blocked', reason))}>{t('p8MarkBlocked')}</button>
          <input aria-label={t('p8MasterName')} placeholder={t('p8MasterName')} style={{ width: 160 }} value={master} onChange={e => setMaster(e.target.value)} />
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need || !master.trim()} onClick={() => void run(() => recordMasterDecision(sailing.id, 'go', master, reason))}>{t('p8MasterGo')}</button>
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need || !master.trim()} onClick={() => void run(() => recordMasterDecision(sailing.id, 'no_go', master, reason))}>{t('p8MasterNoGo')}</button>
          <input aria-label={t('p8PermitReference')} placeholder={t('p8PermitReference')} style={{ width: 150 }} value={permit} onChange={e => setPermit(e.target.value)} />
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => recordPortClearance(sailing.id, 'cleared', permit, reason))}>{t('p8PortCleared')}</button>
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => recordPortClearance(sailing.id, 'not_required', permit, reason))}>{t('p8PortNotRequired')}</button>
          {sailing.status === 'suspended'
            ? <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => resumeSailing(sailing.id, reason))}>{t('p8Resume')}</button>
            : <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => suspendSailing(sailing.id, reason))}>{t('p8Suspend')}</button>}
          {c && c.state === 'below_minimum_after_deadline' && <>
            <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => decideSailingMinimum(sailing.id, 'proceed_below_minimum', reason))}>{t('p8ProceedBelowMin')}</button>
            <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => decideSailingMinimum(sailing.id, 'cancel', reason))}>{t('p8CancelBelowMin')}</button>
          </>}
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => cancelSailing(sailing.id, reason))}>{t('p8CancelSailing')}</button>
          {departed && <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => recordNoShows(sailing.id, reason))}>{t('p8RecordNoShows')}</button>}
        </div>
      )}
      <FlashNotice flash={flash} />
    </div>
  );
}

export default function SailingControlView() {
  const { t } = useLanguage();
  const [from, setFrom] = useState(todayRiyadh(-1));
  const [to, setTo] = useState(todayRiyadh(7));
  const [reason, setReason] = useState('');
  // Two requests for the whole page: the sailing list, then every sailing's minimum status and gate in one batch
  // (previously two extra requests per sailing card — an N+1 that grew with the date range).
  const sailings = useLoad(async () => {
    const list = await listSailingControl(`${from}T00:00:00+03:00`, `${to}T23:59:59+03:00`);
    return { list, statuses: await sailingControlStatus(list.map(x => x.id)) };
  }, [from, to]);
  const templates = useLoad(listScheduleTemplates, []);
  const [gen, setGen] = useState({ from: todayRiyadh(1), to: todayRiyadh(14) });
  const tools = useAction(sailings.reload);
  return (
    <>
      <ProdPageHeader titleKey="p8SailingControlTitle" subKey="p8SailingControlSub" />
      <RequireRoles roles={['super_admin', 'operations', 'boarding_staff']}>
        <section className="card card-pad">
          <div className="notice blue">{t('p8CheckpointsNotice')}</div>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div className="field"><label htmlFor="sc-from">{t('p8From')}</label><input id="sc-from" type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
            <div className="field"><label htmlFor="sc-to">{t('p8To')}</label><input id="sc-to" type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
            <ReasonField id="sc-reason" value={reason} onChange={setReason} />
          </div>
        </section>
        <section className="card card-pad">
          <h2 className="card-title">{t('p8ScheduleTitle')}</h2>
          <p className="card-desc">{t('p8ScheduleBody')}</p>
          {(templates.data ?? []).map(tp => (
            <div key={tp.id} className="request-row"><div><div className="request-title"><span className="mono">{tp.departureLocal}</span> · {tp.routeLabel}</div>
              <div className="request-meta">{tp.vesselName} · {tp.seatCapacity} · {tp.notes}</div></div><span className={`pill ${tp.active ? 'pill-green' : 'pill-neutral'}`}>{t(tp.active ? 'p8Active' : 'p8Inactive')}</span></div>
          ))}
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div className="field"><label htmlFor="sg-from">{t('p8From')}</label><input id="sg-from" type="date" value={gen.from} onChange={e => setGen({ ...gen, from: e.target.value })} /></div>
            <div className="field"><label htmlFor="sg-to">{t('p8To')}</label><input id="sg-to" type="date" value={gen.to} onChange={e => setGen({ ...gen, to: e.target.value })} /></div>
          </div>
          <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-outline" disabled={tools.busy} onClick={() => void tools.run(() => generateSailings(gen.from, gen.to), 'p8Generated')}>{t('p8GenerateSailings')}</button>
            <button type="button" className="btn btn-outline" disabled={tools.busy} onClick={() => void tools.run(() => expireStaleHolds(), 'p8HoldsExpired')}>{t('p8ExpireHolds')}</button>
          </div>
          <FlashNotice flash={tools.flash} />
        </section>
        {sailings.error && <div className="notice danger" role="alert">{t(sailings.error)}</div>}
        {!sailings.data && !sailings.error && <div className="card card-pad" role="status">{t('p4Loading')}</div>}
        {sailings.data?.list.length === 0 && <div className="card card-pad"><div className="no-data">{t('p8NoRows')}</div></div>}
        {sailings.data?.list.map(s => <SailingCard key={s.id} sailing={s} status={sailings.data?.statuses.get(s.id)} reason={reason} onDone={sailings.reload} />)}
      </RequireRoles>
    </>
  );
}
