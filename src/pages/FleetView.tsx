import { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { Icon } from '../components/Icon';
import { BOATS, today } from '../data/demoData';
import { TIME_SLOTS, findSlot, formatTime } from '../domain/fleet';

export default function FleetView() {
  const { t, tx, lang } = useLanguage();
  const { boatSlots, releaseSlot } = useDemo();
  const { toast, openModal } = useUi();
  const [date, setDate] = useState(today());

  const daySlots = boatSlots.filter(s => s.date === date).sort((a, b) => a.time.localeCompare(b.time) || a.boatId.localeCompare(b.boatId));
  const upcoming = [...boatSlots].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const boatName = (id: string) => BOATS.find(b => b.id === id)?.name[lang] ?? id;

  const askRelease = (id: string) => openModal({
    title: t('releaseTitle'), desc: t('releaseReason'), confirmText: t('confirm'), requireReason: true,
    onConfirm: reason => { releaseSlot(id, reason); toast(t('released')); },
  });

  return (
    <>
      <PageHeader titleKey="fleetTitle" subKey="fleetSub" />
      <div className="notice warn" style={{ marginBottom: 16 }}><strong>{t('namesPending')}</strong>{t('charterWholeBoat')}</div>

      <div className="field" style={{ maxWidth: 260, marginBottom: 16 }}>
        <label htmlFor="fleet-date">{t('date')}</label>
        <input id="fleet-date" type="date" value={date} onChange={e => setDate(e.target.value || today())} />
      </div>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        {BOATS.map(boat => {
          const mine = daySlots.filter(s => s.boatId === boat.id);
          const next = upcoming.find(s => s.boatId === boat.id && (s.date > date || (s.date === date)));
          return (
            <div key={boat.id} className="metric boat-card">
              <span className="metric-mark"><Icon name="ship" /></span>
              <div className="metric-label mono">{boat.id}</div>
              <div className="boat-card-name">{boat.name[lang]}</div>
              <div className="metric-foot">{t('bookingsOnDay')}: <strong>{mine.length}</strong></div>
              <div className="metric-foot">{t('nextBooking')}: <strong>{next ? `${next.date} · ${formatTime(next.time, lang)} · ${tx(next.kind === 'charter' ? 'Charter' : 'Scheduled sailing')}` : t('noneBooked')}</strong></div>
            </div>
          );
        })}
      </div>

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
              {BOATS.map(boat => (
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
