import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLanguage } from '../context/LanguageContext';
import {
  getSailingManifest, listRoutes, listScheduleSailings, listVessels, saveRoute, saveSailing, saveVessel,
  type ManifestEntry, type RecordStatus, type Route, type Sailing, type SailingStatus, type Vessel,
} from '../lib/bookingService';
import { ProdPageHeader, RequireRoles, SailingTime, dataErrorKey } from '../components/ProductionUi';
import { Stepper } from '../components/Stepper';
import { useUi } from '../context/UiContext';
import { saudiDateTimeParts, saudiDateTimeToIso } from '../domain/dates';

/**
 * ATCO operations (`/admin/operations`, production only): vessels, routes, the sailing
 * schedule and the reservations on each departure. Writes go straight to the tables, where RLS
 * admits only super_admin/operations and column grants keep seats_booked server-managed.
 * No names, capacities or departures are pre-filled: everything is entered by ATCO staff.
 */

type Tab = 'sailings' | 'vessels' | 'routes';
type Message = { tone: 'ok' | 'error'; text: string } | null;

function useGuardedAction() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { await action(); } finally { inFlight.current = false; setBusy(false); }
  }, []);
  return { busy, run };
}

function Notice({ message }: { message: Message }) {
  if (!message) return null;
  return <div className={`notice ${message.tone === 'ok' ? '' : 'danger'}`} role={message.tone === 'ok' ? 'status' : 'alert'} style={{ marginTop: 12 }}>{message.text}</div>;
}

const STATUS_KEY: Record<SailingStatus, string> = { open: 'opsStatusOpen', closed: 'opsStatusClosed', suspended: 'p8SailingSuspended', cancelled: 'opsStatusCancelled' };

/* --------------------------------- vessels -------------------------------- */

function VesselsPanel({ vessels, reload }: { vessels: Vessel[]; reload: () => Promise<void> }) {
  const { t } = useLanguage();
  const { openModal } = useUi();
  const retire = (vessel: Vessel) => {
    openModal({
      title: t('opsRetireTitle'), desc: t('opsRetireDesc'), confirmText: t('opsRetire'),
      requireReason: false, danger: true,
      onConfirm: () => {
        void run(async () => {
          try {
            await saveVessel({ id: vessel.id, name: vessel.name, passengerCapacity: vessel.passengerCapacity, status: 'inactive' });
            setMessage({ tone: 'ok', text: t('opsSaved') });
            await reload();
          } catch (error) { setMessage({ tone: 'error', text: t(dataErrorKey(error)) }); }
        });
      },
    });
  };
  const empty = { id: '', name: '', capacity: '', status: 'active' as RecordStatus };
  const [form, setForm] = useState(empty);
  const [message, setMessage] = useState<Message>(null);
  const { busy, run } = useGuardedAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const capacity = form.capacity.trim() === '' ? null : Number(form.capacity);
      if (!form.name.trim() || (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000))) {
        setMessage({ tone: 'error', text: t('dsErrInvalid') });
        return;
      }
      try {
        await saveVessel({ id: form.id || undefined, name: form.name, passengerCapacity: capacity, status: form.status });
        setMessage({ tone: 'ok', text: t('opsSaved') });
        setForm(empty);
        await reload();
      } catch (error) { setMessage({ tone: 'error', text: t(dataErrorKey(error)) }); }
    });
  };

  return (
    <div className="grid">
      <section className="card card-pad" aria-labelledby="ops-vessel-form">
        <h2 id="ops-vessel-form" className="card-title">{form.id ? t('opsEditVessel') : t('opsAddVessel')}</h2>
        <form className="form-grid" style={{ marginTop: 12 }} onSubmit={submit} aria-busy={busy}>
          <div className="field"><label htmlFor="ops-vessel-name">{t('opsVesselName')} *</label>
            <input id="ops-vessel-name" maxLength={120} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
          <div className="field"><span className="label" id="ops-vessel-cap-label">{t('opsVesselCapacity')}</span>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Stepper labelledBy="ops-vessel-cap-label"
                value={form.capacity.trim() === '' || !Number.isInteger(Number(form.capacity)) ? null : Number(form.capacity)}
                min={1} max={1000}
                onChange={next => setForm(f => ({ ...f, capacity: next === null ? '' : String(next) }))} />
              {form.capacity !== '' && <button type="button" className="link-btn" onClick={() => setForm(f => ({ ...f, capacity: '' }))}>{t('clearValue')}</button>}
            </div>
            <small>{t('opsVesselCapacityHint')}</small></div>
          <div className="field"><label htmlFor="ops-vessel-status">{t('opsRecordStatus')}</label>
            <select id="ops-vessel-status" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as RecordStatus }))}>
              <option value="active">{t('opsActive')}</option><option value="inactive">{t('opsInactive')}</option>
            </select></div>
          <div className="row" style={{ alignSelf: 'end', flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={busy}>{t('opsSave')}</button>
            {form.id && <button type="button" className="btn btn-outline" onClick={() => setForm(empty)}>{t('cancel')}</button>}
          </div>
        </form>
        <Notice message={message} />
      </section>
      <section className="card card-pad">
        {vessels.length === 0 && <div className="no-data">{t('opsNoVessels')}</div>}
        {vessels.map(v => (
          <div key={v.id} className="request-row">
            <div><div className="request-title">{v.name}</div>
              <div className="request-meta">{v.passengerCapacity === null ? t('opsCapacityNotRecorded') : t('opsCapacityN').replace('{n}', String(v.passengerCapacity))}</div></div>
            <div className="row">
              <span className={`pill ${v.status === 'active' ? 'pill-green' : 'pill-neutral'}`}>{t(v.status === 'active' ? 'opsActive' : 'opsInactive')}</span>
              <button type="button" className="btn btn-outline btn-small" onClick={() => setForm({ id: v.id, name: v.name, capacity: v.passengerCapacity === null ? '' : String(v.passengerCapacity), status: v.status })}>{t('opsEdit')}</button>
              {v.status === 'active' && <button type="button" className="btn btn-danger btn-small" onClick={() => retire(v)}>{t('opsRetire')}</button>}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

/* ---------------------------------- routes -------------------------------- */

function RoutesPanel({ routes, reload }: { routes: Route[]; reload: () => Promise<void> }) {
  const { t } = useLanguage();
  const empty = { id: '', origin: '', destination: '', status: 'active' as RecordStatus };
  const [form, setForm] = useState(empty);
  const [message, setMessage] = useState<Message>(null);
  const { busy, run } = useGuardedAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      try {
        await saveRoute({ id: form.id || undefined, origin: form.origin, destination: form.destination, status: form.status });
        setMessage({ tone: 'ok', text: t('opsSaved') });
        setForm(empty);
        await reload();
      } catch (error) { setMessage({ tone: 'error', text: t(dataErrorKey(error)) }); }
    });
  };

  return (
    <div className="grid">
      <section className="card card-pad" aria-labelledby="ops-route-form">
        <h2 id="ops-route-form" className="card-title">{form.id ? t('opsEditRoute') : t('opsAddRoute')}</h2>
        <p className="card-desc">{t('opsRouteHint')}</p>
        <form className="form-grid" style={{ marginTop: 12 }} onSubmit={submit} aria-busy={busy}>
          <div className="field"><label htmlFor="ops-route-origin">{t('opsOrigin')} *</label>
            <input id="ops-route-origin" maxLength={120} value={form.origin} onChange={e => setForm(f => ({ ...f, origin: e.target.value }))} /></div>
          <div className="field"><label htmlFor="ops-route-dest">{t('opsDestination')} *</label>
            <input id="ops-route-dest" maxLength={120} value={form.destination} onChange={e => setForm(f => ({ ...f, destination: e.target.value }))} /></div>
          <div className="field"><label htmlFor="ops-route-status">{t('opsRecordStatus')}</label>
            <select id="ops-route-status" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as RecordStatus }))}>
              <option value="active">{t('opsActive')}</option><option value="inactive">{t('opsInactive')}</option>
            </select></div>
          <div className="row" style={{ alignSelf: 'end', flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={busy}>{t('opsSave')}</button>
            {form.id && <button type="button" className="btn btn-outline" onClick={() => setForm(empty)}>{t('cancel')}</button>}
          </div>
        </form>
        <Notice message={message} />
      </section>
      <section className="card card-pad">
        {routes.length === 0 && <div className="no-data">{t('opsNoRoutes')}</div>}
        {routes.map(r => (
          <div key={r.id} className="request-row">
            <div className="request-title">{r.origin} → {r.destination}</div>
            <div className="row">
              <span className={`pill ${r.status === 'active' ? 'pill-green' : 'pill-neutral'}`}>{t(r.status === 'active' ? 'opsActive' : 'opsInactive')}</span>
              <button type="button" className="btn btn-outline btn-small" onClick={() => setForm({ id: r.id, origin: r.origin, destination: r.destination, status: r.status })}>{t('opsEdit')}</button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

/* --------------------------------- sailings ------------------------------- */

function Manifest({ sailing }: { sailing: Sailing }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<ManifestEntry[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try { setRows(await getSailingManifest(sailing.id)); } catch (e) { setRows(null); setError(dataErrorKey(e)); }
  }, [sailing.id]);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className="card card-pad" aria-labelledby="ops-manifest">
      <div className="between">
        <h2 id="ops-manifest" className="card-title">{t('opsManifestTitle')}</h2>
        <button type="button" className="btn btn-outline btn-small" onClick={() => void load()}>{t('pbRefresh')}</button>
      </div>
      <p className="card-desc">{sailing.route.origin} → {sailing.route.destination} · <SailingTime iso={sailing.departsAt} /> · {sailing.vessel.name}</p>
      {error && <div className="notice danger" role="alert" style={{ marginTop: 10 }}>{t(error)}</div>}
      {!error && rows === null && <div className="card-desc" role="status">{t('onbLoading')}</div>}
      {rows && rows.length === 0 && <div className="no-data" style={{ marginTop: 10 }}>{t('opsManifestEmpty')}</div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>{t('pbReference')}</th><th>{t('pbOrganization')}</th><th>{t('pbLeadName')}</th><th>{t('pbContactPhone')}</th><th>{t('opsLeg')}</th><th>{t('pbPassengerCount')}</th></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={`${r.reference}-${r.leg}`}><td className="mono">{r.reference}</td><td>{r.organizationName}</td><td>{r.contactName}</td>
                <td dir="ltr">{r.contactPhone}</td><td>{t(r.leg === 'return' ? 'pbReturn' : 'pbOutbound')}</td><td>{r.passengers}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SailingsPanel({ sailings, routes, vessels, reload }: { sailings: Sailing[]; routes: Route[]; vessels: Vessel[]; reload: () => Promise<void> }) {
  const { t } = useLanguage();
  const empty = { id: '', routeId: '', vesselId: '', date: '', time: '', capacity: '', status: 'open' as SailingStatus };
  const [form, setForm] = useState(empty);
  const [message, setMessage] = useState<Message>(null);
  const [manifestFor, setManifestFor] = useState<Sailing | null>(null);
  const { busy, run } = useGuardedAction();
  const editing = sailings.find(s => s.id === form.id) ?? null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const departsAt = saudiDateTimeToIso(form.date, form.time);
      const capacity = Number(form.capacity);
      if (!form.routeId || !form.vesselId || !departsAt || !Number.isInteger(capacity) || capacity < 1 || capacity > 1000) {
        setMessage({ tone: 'error', text: t('dsErrInvalid') });
        return;
      }
      try {
        await saveSailing({ id: form.id || undefined, routeId: form.routeId, vesselId: form.vesselId, departsAt, seatCapacity: capacity, status: form.status });
        setMessage({ tone: 'ok', text: t('opsSaved') });
        setForm(empty);
        await reload();
      } catch (error) { setMessage({ tone: 'error', text: t(dataErrorKey(error)) }); }
    });
  };

  const edit = (s: Sailing) => {
    const { date, time } = saudiDateTimeParts(s.departsAt);
    setForm({ id: s.id, routeId: s.route.id, vesselId: s.vessel.id, date, time, capacity: String(s.seatCapacity), status: s.status });
    setMessage(null);
  };

  return (
    <div className="grid">
      <section className="card card-pad" aria-labelledby="ops-sailing-form">
        <h2 id="ops-sailing-form" className="card-title">{form.id ? t('opsEditSailing') : t('opsAddSailing')}</h2>
        <p className="card-desc">{t('opsSailingHint')}</p>
        <form className="form-grid" style={{ marginTop: 12 }} onSubmit={submit} aria-busy={busy}>
          <div className="field"><label htmlFor="ops-s-route">{t('pbRoute')} *</label>
            <select id="ops-s-route" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))}>
              <option value="">{t('pbChoose')}</option>
              {routes.filter(r => r.status === 'active' || r.id === form.routeId).map(r => <option key={r.id} value={r.id}>{r.origin} → {r.destination}</option>)}
            </select></div>
          <div className="field"><label htmlFor="ops-s-vessel">{t('opsVessel')} *</label>
            <select id="ops-s-vessel" value={form.vesselId} onChange={e => setForm(f => ({ ...f, vesselId: e.target.value }))}>
              <option value="">{t('pbChoose')}</option>
              {vessels.filter(v => v.status === 'active' || v.id === form.vesselId).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select></div>
          <div className="field"><label htmlFor="ops-s-date">{t('opsDate')} *</label>
            <input id="ops-s-date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></div>
          <div className="field"><label htmlFor="ops-s-time">{t('opsTime')} *</label>
            <input id="ops-s-time" type="time" value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))} />
            <small>{t('localTime')}</small></div>
          <div className="field"><label htmlFor="ops-s-cap">{t('opsSeatCapacity')} *</label>
            <input id="ops-s-cap" type="number" min={Math.max(1, editing?.seatsBooked ?? 1)} max={1000} inputMode="numeric" value={form.capacity}
              onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))} />
            {editing && <small>{t('opsSeatsBookedN').replace('{n}', String(editing.seatsBooked))}</small>}</div>
          <div className="field"><label htmlFor="ops-s-status">{t('opsSailingStatus')}</label>
            <select id="ops-s-status" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as SailingStatus }))}
              disabled={editing?.status === 'cancelled'}>
              <option value="open">{t('opsStatusOpen')}</option><option value="closed">{t('opsStatusClosed')}</option><option value="cancelled">{t('opsStatusCancelled')}</option>
            </select>
            <small>{t('opsStatusHint')}</small></div>
          <div className="row" style={{ alignSelf: 'end', flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={busy || editing?.status === 'cancelled'}>{t('opsSave')}</button>
            {form.id && <button type="button" className="btn btn-outline" onClick={() => setForm(empty)}>{t('cancel')}</button>}
          </div>
        </form>
        <Notice message={message} />
      </section>
      <section className="card card-pad" aria-labelledby="ops-schedule">
        <h2 id="ops-schedule" className="card-title">{t('opsScheduleTitle')}</h2>
        {sailings.length === 0 && <div className="no-data" style={{ marginTop: 10 }}>{t('opsNoSailings')}</div>}
        {sailings.map(s => (
          <div key={s.id} className="request-row">
            <div>
              <div className="request-title">{s.route.origin} → {s.route.destination}</div>
              <div className="request-meta"><SailingTime iso={s.departsAt} /> · {s.vessel.name} · {t('opsBookedOf').replace('{n}', String(s.seatsBooked)).replace('{cap}', String(s.seatCapacity))}</div>
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <span className={`pill ${s.status === 'open' ? 'pill-green' : s.status === 'closed' ? 'pill-gold' : 'pill-red'}`}>{t(STATUS_KEY[s.status])}</span>
              <button type="button" className="btn btn-outline btn-small" onClick={() => edit(s)}>{t('opsEdit')}</button>
              <button type="button" className="btn btn-outline btn-small" aria-pressed={manifestFor?.id === s.id} onClick={() => setManifestFor(s)}>{t('opsViewManifest')}</button>
            </div>
          </div>
        ))}
      </section>
      {manifestFor && <Manifest key={manifestFor.id} sailing={manifestFor} />}
    </div>
  );
}

function OperationsScreen() {
  const { t } = useLanguage();
  const [tab, setTab] = useState<Tab>('sailings');
  const [data, setData] = useState<{ sailings: Sailing[]; routes: Route[]; vessels: Vessel[] } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const [sailings, routes, vessels] = await Promise.all([listScheduleSailings(), listRoutes(), listVessels()]);
      setData({ sailings, routes, vessels });
    } catch (e) { setError(dataErrorKey(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <ProdPageHeader titleKey="aoTitle" subKey="aoSub" />
      <div className="tabbar" role="tablist" aria-label={t('aoTitle')}>
        {(['sailings', 'vessels', 'routes'] as const).map(k => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
            {t(k === 'sailings' ? 'opsTabSailings' : k === 'vessels' ? 'opsTabVessels' : 'opsTabRoutes')}
          </button>
        ))}
      </div>
      {error && <div className="notice danger" role="alert">{t(error)} <button type="button" className="link-btn" onClick={() => void load()}>{t('screenErrorRetry')}</button></div>}
      {!error && !data && <div className="card card-pad" role="status">{t('onbLoading')}</div>}
      {data && tab === 'sailings' && <SailingsPanel sailings={data.sailings} routes={data.routes} vessels={data.vessels} reload={load} />}
      {data && tab === 'vessels' && <VesselsPanel vessels={data.vessels} reload={load} />}
      {data && tab === 'routes' && <RoutesPanel routes={data.routes} reload={load} />}
    </>
  );
}

export default function AdminOperationsView() {
  return <RequireRoles roles={['super_admin', 'operations']}><OperationsScreen /></RequireRoles>;
}
