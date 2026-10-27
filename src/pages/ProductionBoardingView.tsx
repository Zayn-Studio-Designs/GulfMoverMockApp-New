import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useCameraScanner } from '../hooks/useCameraScanner';
import { useLanguage } from '../context/LanguageContext';
import { usePlatformRoles } from '../context/OnboardingContext';
import { ProdPageHeader, RequireRoles, SailingTime, dataErrorKey } from '../components/ProductionUi';
import { listScheduleSailings, type Sailing } from '../lib/bookingService';
import { boardTicket, getTicketManifest, listReadinessEvents, setSailingReadiness,
  type ManifestTicket, type ReadinessEvent, type ReadinessStatus } from '../lib/ticketService';

function Desk() {
  const { t } = useLanguage(); const roles = usePlatformRoles();
  const canDecide = roles?.some(r => ['super_admin','operations'].includes(r));
  const [sailings, setSailings] = useState<Sailing[] | null>(null); const [selected, setSelected] = useState('');
  const [manifest, setManifest] = useState<ManifestTicket[] | null>(null); const [events, setEvents] = useState<ReadinessEvent[]>([]);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [code, setCode] = useState(''); const [reason, setReason] = useState('');
  const [decision, setDecision] = useState<ReadinessStatus>('pending'); const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0); const inFlight = useRef(false);
  const [camera,setCamera] = useState(false);
  const scanner = useCameraScanner(camera,payload=>{ setCode(payload); setCamera(false); });
  useEffect(() => {
    let active = true;
    void listScheduleSailings().then(data => { if (active) setSailings(data); }).catch(e => { if (active) setError(dataErrorKey(e)); });
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    let active = true; setManifest(null); setEvents([]);
    if (!selected) return;
    void Promise.all([getTicketManifest(selected), canDecide ? listReadinessEvents(selected) : Promise.resolve([])])
      .then(([tickets, history]) => { if (active) { setManifest(tickets); setEvents(history); } })
      .catch(e => { if (active) setError(dataErrorKey(e)); });
    return () => { active = false; };
  }, [selected, revision, canDecide]);
  const sailing = sailings?.find(s => s.id === selected);
  async function action(event: FormEvent, operation: () => Promise<string>) {
    event.preventDefault(); if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try { setMessage(await operation()); setRevision(v => v + 1); }
    catch (e) { setError(dataErrorKey(e)); }
    finally { setBusy(false); inFlight.current = false; }
  }
  return <>
    <ProdPageHeader titleKey="p4Boarding" subKey="p4InternalOnly" />
    <div className="notice warn">{t('p5CameraNotice')}</div>
    {error && <p role="alert" className="notice danger">{t(error)}</p>}
    {message && <p role="status" className="notice">{t(message)}</p>}
    <section className="card card-pad" style={{ marginTop: 12 }}>
      <label htmlFor="p4-sailing">{t('selectSailing')}</label>
      <select id="p4-sailing" value={selected} disabled={busy} style={{ width: '100%', minWidth: 0 }} onChange={e => {
        setCamera(false); setSelected(e.target.value); setError(''); setMessage(''); setCode(''); setReason('');
      }}>
        <option value="">{t('p4ChooseSailing')}</option>
        {sailings?.map(s => <option key={s.id} value={s.id}>{s.route.origin} → {s.route.destination} · {s.departsAt} · {s.vessel.name}</option>)}
      </select>
      {!sailings && !error && <p role="status">{t('p4Loading')}</p>}
      {sailing && <div style={{ marginTop: 12 }}>
        <SailingTime iso={sailing.departsAt} />
        <p>{t('readiness')}: {t(`p4Readiness_${sailing.readinessStatus}`)}</p>
        <p>{t(sailing.status === 'cancelled' ? 'opsStatusCancelled' : sailing.status === 'closed' ? 'opsStatusClosed' : 'opsStatusOpen')}</p>
        {sailing.seatsBooked < 4 && <p className="notice warn">{t('p4MinimumWarning')}</p>}
      </div>}
    </section>
    {selected && <>
      {canDecide && <section className="card card-pad" style={{ marginTop: 12 }}>
        <h2 className="card-title">{t('p4ReadinessTitle')}</h2>
        <form onSubmit={e => void action(e, async () => {
          const result = await setSailingReadiness(selected, decision, reason);
          return result === 'recorded' ? 'p4ReadinessSaved' : 'p4ReadinessUnchanged';
        })}>
          <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
            <label htmlFor="p4-decision">{t('p4Decision')}</label>
            <select id="p4-decision" value={decision} onChange={e => setDecision(e.target.value as ReadinessStatus)}>
              {(['pending','ready','blocked'] as const).map(s => <option key={s} value={s}>{t(`p4Readiness_${s}`)}</option>)}
            </select>
            <label htmlFor="p4-reason">{t('reasonLabel')}</label>
            <textarea id="p4-reason" required maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={!reason.trim() || sailing?.status === 'cancelled'}>{t('p4SaveReadiness')}</button>
          </fieldset>
        </form>
        {events.map(e => <div className="request-row" key={e.id}><div><strong>{t(`p4Readiness_${e.status}`)}</strong><p style={{ overflowWrap: 'anywhere' }}>{e.reason}</p><SailingTime iso={e.occurredAt} /></div></div>)}
      </section>}
      <section className="card card-pad" style={{ marginTop: 12 }}>
        <h2 className="card-title">{t('p4RecordBoarding')}</h2>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={()=>setCamera(v=>!v)}>{t(camera?'p5CameraStop':'p5CameraStart')}</button>
        <p role="status">{t('p5Camera_'+scanner.state)}</p>
        {camera&&<video ref={scanner.videoRef} muted playsInline aria-label={t('p5CameraStart')} style={{width:'100%',maxWidth:480}}/>}
        <form onSubmit={e => void action(e, async () => { setCamera(false); return `p4Scan_${await boardTicket(code, selected)}`; })}>
          <label htmlFor="p4-code">{t('p4Lookup')}</label>
          <input id="p4-code" value={code} maxLength={100} autoComplete="off" disabled={busy} style={{ width: '100%', minWidth: 0 }} onChange={e => setCode(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()} style={{ marginTop: 10 }}>{t('p4RecordBoarding')}</button>
        </form>
        <p className="small">{t('p4BoardingAtomic')}</p>
      </section>
      <section className="card card-pad" style={{ marginTop: 12 }}>
        <div className="between"><h2 className="card-title">{t('manifest')}</h2>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => { setError(''); setRevision(v => v + 1); }}>{t('pbRefresh')}</button></div>
        {!manifest && !error && <p role="status">{t('p4Loading')}</p>}
        {manifest?.length === 0 && <p>{t('p4EmptyManifest')}</p>}
        {manifest?.map(ticket => <article className="request-row" key={ticket.id} style={{ overflowWrap: 'anywhere' }}>
          <div><strong className="mono">{ticket.reference}</strong><p>{ticket.bookingReference} · {t(ticket.leg === 'return' ? 'pbReturn' : 'pbOutbound')}</p>
            <p>{t('ticketPassenger')} {ticket.passengerIndex}: {ticket.passengerName || t('p4NameNotCollected')}</p>
            <span className="pill pill-neutral">{t(`p4Ticket_${ticket.status}`)}</span></div>
        </article>)}
      </section>
    </>}
  </>;
}
export default function ProductionBoardingView() {
  return <RequireRoles roles={['super_admin','operations','boarding_staff']}><Desk /></RequireRoles>;
}
