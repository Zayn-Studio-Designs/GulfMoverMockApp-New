import { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useDemo, type DemoBoat } from '../context/DemoContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { Icon } from '../components/Icon';
import { Stepper } from '../components/Stepper';
import { today } from '../data/demoData';
import { TIME_SLOTS, findSlot, formatTime } from '../domain/fleet';
import type { DemoConfig } from '../context/DemoContext';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Demo-only admin panel: illustrative fare/schedule/capacity saved in this browser. */
function DemoConfigPanel({ boats }: { boats: DemoBoat[] }) {
  const { t, lang } = useLanguage();
  const { config, setConfig } = useDemo();
  const { toast } = useUi();
  const [fare, setFare] = useState(String(config.farePerPassenger));
  const [addTime, setAddTime] = useState('');
  const [error, setError] = useState('');
  const [seats, setSeats] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(config.seatsPerBoat).map(([id, n]) => [id, n === null || n === undefined ? '' : String(n)])));

  const save = () => {
    const fareN = Number(fare);
    if (!Number.isFinite(fareN) || fareN < 1 || fareN > 10000) { setError('adminErrFare'); return; }
    const seatsNext: DemoConfig['seatsPerBoat'] = {};
    for (const boatId of boats.map(b => b.id)) {
      const raw = (seats[boatId] ?? '').trim();
      if (raw === '') { seatsNext[boatId] = null; continue; }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 400) { setError('adminErrCapacity'); return; }
      seatsNext[boatId] = n;
    }
    setError('');
    setConfig({ farePerPassenger: fareN, seatsPerBoat: seatsNext });
    toast(t('adminSaved'));
  };

  const addTimeSlot = () => {
    if (!TIME_RE.test(addTime.trim())) { setError('adminErrTime'); return; }
    setError('');
    setConfig({ schedule: [...config.schedule, addTime.trim()].sort() });
    setAddTime('');
  };

  return (
    <div className="card card-pad fleet-config" style={{ marginBottom: 16 }}>
      <div className="between" style={{ flexWrap: 'wrap' }}>
        <div><h2 className="card-title">{t('adminConfigTitle')}</h2><p className="card-desc">{t('adminConfigSub')}</p></div>
        <span className="pill pill-gold">{t('demoOnly')}</span>
      </div>
      {error && <div className="notice danger" role="alert" style={{ marginTop: 12 }}>{t(error)}</div>}
      <div className="set-group">
        <h3 className="set-group-title">{t('adminFare')}</h3>
        <div className="cfg-fare-row">
          <input id="demo-fare" className="mono" type="number" min={1} max={10000} dir="ltr"
            aria-describedby="demo-fare-hint" value={fare} onChange={e => setFare(e.target.value)} />
          <p className="card-desc" id="demo-fare-hint">{t('adminFareHint')}</p>
        </div>
      </div>
      <hr className="set-sep" />
      <div className="set-group">
        <h3 className="set-group-title">{t('adminSchedule')}</h3>
        {config.schedule.length === 0 && <p className="card-desc" style={{ marginTop: 6 }}>{t('noDeparturesYet')}</p>}
        <ul className="plain-list sched-list">
          {config.schedule.map(time => (
            <li key={time} className="sched-row">
              <span className="sched-time mono">{formatTime(time, lang)}</span>
              <span className="sched-raw mono muted" dir="ltr">{time}</span>
              <button type="button" className="btn btn-outline btn-small" aria-label={`${t('adminRemoveTime')}: ${formatTime(time, lang)}`}
                onClick={() => setConfig({ schedule: config.schedule.filter(x => x !== time) })}>{t('adminRemoveTime')}</button>
            </li>
          ))}
        </ul>
        <div className="row time-add" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <input type="time" aria-label={t('adminAddTimeLabel')} dir="ltr"
            value={addTime} onChange={e => setAddTime(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTimeSlot(); } }} />
          <button type="button" className="btn btn-outline btn-small" onClick={addTimeSlot}>{t('adminAddTime')}</button>
        </div>
      </div>
      <hr className="set-sep" />
      <div className="set-group">
        <h3 className="set-group-title">{t('adminCapacity')}</h3>
        <p className="card-desc" style={{ marginTop: 4 }}>{t('adminNullCap')}</p>
        <ul className="plain-list seats-list">
          {boats.map(boat => {
            const raw = (seats[boat.id] ?? '').trim();
            const n = raw === '' ? null : Number(raw);
            const current = raw === '' || !Number.isInteger(n) ? null : (n as number);
            return (
              <li className="seats-row" key={boat.id}>
                <span className="seats-id" id={`seats-label-${boat.id}`}>
                  <strong>{boat.name[lang]}</strong><span className="mono tiny muted">{boat.id}</span>
                </span>
                <span className="seats-ctl">
                  <Stepper labelledBy={`seats-label-${boat.id}`} value={current} min={1} max={400}
                    onChange={next => setSeats(prev => ({ ...prev, [boat.id]: next === null ? '' : String(next) }))} />
                  <span className="small muted seats-unit">{current === null ? t('adminNullCapShort') : `${current} ${t('seatsUnit')}`}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="save-row" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-primary" onClick={save}>{t('adminSave')}</button>
      </div>
    </div>
  );
}

export default function FleetView() {
  const { t, tx, lang } = useLanguage();
  const { boats, activeBoats, addBoat, renameBoat, retireBoat, reinstateBoat, boatSlots, releaseSlot } = useDemo();
  const { toast, openModal } = useUi();
  const [date, setDate] = useState(today());
  const [editing, setEditing] = useState<{ id: string; nameEn: string; nameAr: string } | null>(null);
  const [formError, setFormError] = useState('');

  const daySlots = boatSlots.filter(s => s.date === date).sort((a, b) => a.time.localeCompare(b.time) || a.boatId.localeCompare(b.boatId));
  const upcoming = [...boatSlots].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const boatName = (id: string) => boats.find(b => b.id === id)?.name[lang] ?? id;
  const retired = boats.filter(b => b.status === 'retired');

  const validBoatName = (nameEn: string, exceptId?: string) => {
    const trimmed = nameEn.trim();
    if (!trimmed) return 'errBoatName';
    if (trimmed.length > 120) return 'errBoatName';
    if (boats.some(b => b.id !== exceptId && b.name.en.toLowerCase() === trimmed.toLowerCase())) return 'errBoatNameTaken';
    return '';
  };

  const saveBoatForm = () => {
    if (!editing) return;
    const err = validBoatName(editing.nameEn, editing.id || undefined);
    setFormError(err);
    if (err) return;
    if (editing.id) {
      renameBoat(editing.id, editing.nameEn, editing.nameAr);
      toast(t('boatRenamed'));
    } else {
      addBoat(editing.nameEn, editing.nameAr);
      toast(t('boatAdded'));
    }
    setEditing(null);
    setFormError('');
  };

  const askRetire = (boat: DemoBoat) => {
    const records = boatSlots.filter(s => s.boatId === boat.id).length;
    openModal({
      title: t('retireBoatTitle'),
      desc: `${boat.name[lang]} (${boat.id}). ${t('retireBoatDesc').replace('{n}', String(records))}`,
      confirmText: t('retireBoat'),
      requireReason: true,
      danger: true,
      onConfirm: reason => { retireBoat(boat.id, reason); toast(t('boatRetired')); },
    });
  };

  const askRelease = (id: string) => openModal({
    title: t('releaseTitle'), desc: t('releaseReason'), confirmText: t('confirm'), requireReason: true,
    onConfirm: reason => { releaseSlot(id, reason); toast(t('released')); },
  });

  return (
    <>
      <PageHeader titleKey="fleetTitle" subKey="fleetSub" />
      <div className="notice warn" style={{ marginBottom: 16 }}><strong>{t('namesPending')}</strong>{t('charterWholeBoat')}</div>

      <section className="card card-pad fleet-vesday" style={{ marginBottom: 16 }} aria-label={t('fleetVesselsDay')}>
        <div className="fleet-daybar">
          <div><h2 className="card-title">{t('fleetVesselsDay')}</h2><p className="card-desc">{t('fleetVesselsDaySub')}</p></div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="field fleet-date-field">
              <label htmlFor="fleet-date">{t('date')}</label>
              <input id="fleet-date" type="date" value={date} onChange={e => setDate(e.target.value || today())} />
            </div>
            <button type="button" className="btn btn-primary btn-small" style={{ alignSelf: 'end' }}
              onClick={() => { setEditing({ id: '', nameEn: '', nameAr: '' }); setFormError(''); }}>{t('addBoat')}</button>
          </div>
        </div>
        {editing && (
          <form className="boat-form" onSubmit={e => { e.preventDefault(); saveBoatForm(); }}>
            <h3 className="card-title">{editing.id ? t('editBoat') : t('addBoat')}</h3>
            {formError && <div className="notice danger" role="alert">{t(formError)}</div>}
            <div className="form-grid">
              <div className="field">
                <label htmlFor="boat-name-en">{t('boatNameEn')} *</label>
                <input id="boat-name-en" maxLength={120} value={editing.nameEn}
                  onChange={e => setEditing(s => (s ? { ...s, nameEn: e.target.value } : s))} />
              </div>
              <div className="field">
                <label htmlFor="boat-name-ar">{t('boatNameAr')}</label>
                <input id="boat-name-ar" maxLength={120} lang="ar" value={editing.nameAr}
                  onChange={e => setEditing(s => (s ? { ...s, nameAr: e.target.value } : s))} />
              </div>
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button type="submit" className="btn btn-primary btn-small">{t('saveChanges')}</button>
              <button type="button" className="btn btn-outline btn-small" onClick={() => setEditing(null)}>{t('cancel')}</button>
            </div>
          </form>
        )}
        <ul className="plain-list vessel-list">
          {activeBoats.map(boat => {
            const mine = daySlots.filter(s => s.boatId === boat.id);
            const next = upcoming.find(s => s.boatId === boat.id && (s.date > date || (s.date === date)));
            return (
              <li key={boat.id} className="vessel-row">
                <span className="vessel-mark" aria-hidden="true"><Icon name="ship" /></span>
                <span className="vessel-id"><strong>{boat.name[lang]}</strong><span className="mono tiny muted">{boat.id}</span></span>
                <span className="vessel-stat"><span className="vessel-stat-num">{mine.length}</span>{t('bookingsOnDay')}</span>
                <span className="vessel-next">{t('nextBooking')}: <strong>{next ? `${next.date} · ${formatTime(next.time, lang)}` : t('noneBooked')}</strong></span>
                <span className="vessel-actions">
                  <button type="button" className="btn btn-outline btn-small"
                    onClick={() => { setEditing({ id: boat.id, nameEn: boat.name.en, nameAr: boat.name.ar }); setFormError(''); }}>{t('editBoat')}</button>
                  <button type="button" className="btn btn-danger btn-small"
                    disabled={activeBoats.length <= 1} title={activeBoats.length <= 1 ? t('errLastBoat') : undefined}
                    onClick={() => askRetire(boat)}>{t('retireBoat')}</button>
                </span>
              </li>
            );
          })}
        </ul>
        {retired.length > 0 && (
          <div className="retired-group">
            <h3 className="retired-title">{t('retiredBoats')}</h3>
            <ul className="plain-list vessel-list">
              {retired.map(boat => (
                <li key={boat.id} className="vessel-row vessel-retired">
                  <span className="vessel-mark" aria-hidden="true"><Icon name="ship" /></span>
                  <span className="vessel-id"><strong>{boat.name[lang]}</strong><span className="mono tiny muted">{boat.id}</span></span>
                  <span className="vessel-actions">
                    <button type="button" className="btn btn-outline btn-small"
                      onClick={() => { reinstateBoat(boat.id); toast(t('boatReinstated')); }}>{t('reinstateBoat')}</button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <DemoConfigPanel boats={activeBoats} />

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="between" style={{ flexWrap: 'wrap' }}>
          <div><h2 className="card-title">{t('dayView')} · {date}</h2><p className="card-desc">{t('dayViewSub')}</p></div>
          <div className="legend">
            <span><i className="cell-free" />{t('legendFree')}</span>
            <span><i className="cell-shared" />{t('legendShared')}</span>
            <span><i className="cell-charter" />{t('legendCharter')}</span>
          </div>
        </div>
        <div className="timeline-wrap" role="region" aria-label={t('dayView')} tabIndex={0}>
          <table className="timeline">
            <thead><tr><th scope="col">{t('boat')}</th>{TIME_SLOTS.map(s => <th key={s} scope="col" className="mono">{formatTime(s, lang)}</th>)}</tr></thead>
            <tbody>
              {activeBoats.map(boat => (
                <tr key={boat.id}>
                  <th scope="row">{boat.name[lang]}</th>
                  {TIME_SLOTS.map(time => {
                    const slot = findSlot(boatSlots, boat.id, date, time);
                    const cls = !slot ? 'cell-free' : slot.kind === 'charter' ? 'cell-charter' : 'cell-shared';
                    const text = !slot ? '' : slot.kind === 'charter' ? t('legendCharter') : `${slot.passengers}`;
                    return <td key={time} className={cls} title={`${boat.name[lang]} · ${formatTime(time, lang)} · ${slot ? tx(slot.holder) : t('legendFree')}`}>{text}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad">
        <h2 className="card-title">{t('rentals')}</h2>
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table>
            <thead><tr>
              <th>{t('boat')}</th><th>{t('date')}</th><th>{t('time')}</th><th>{t('type')}</th>
              <th>{t('bookedBy')}</th><th>{t('passengers')}</th><th>{t('status')}</th><th>{t('actions')}</th>
            </tr></thead>
            <tbody>
              {upcoming.map(s => (
                <tr key={s.id}>
                  <td data-label={t('boat')}><strong>{boatName(s.boatId)}</strong><div className="tiny muted mono">{s.refs.join(', ')}</div></td>
                  <td data-label={t('date')} className="nowrap">{s.date}</td>
                  <td data-label={t('time')} className="mono nowrap">{formatTime(s.time, lang)}</td>
                  <td data-label={t('type')}>{tx(s.kind === 'charter' ? 'Charter' : 'Scheduled sailing')}</td>
                  <td data-label={t('bookedBy')}>{tx(s.holder)}</td>
                  <td data-label={t('passengers')}>{s.passengers}</td>
                  <td data-label={t('status')}><StatusPill text={s.status} /></td>
                  <td data-label={t('actions')}><button type="button" className="btn btn-danger btn-small" onClick={() => askRelease(s.id)}>{t('release')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {upcoming.length === 0 && <div className="empty">{t('noRentals')}</div>}
        </div>
      </div>
    </>
  );
}
