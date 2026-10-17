import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { Icon, type IconName } from '../components/Icon';
import { isMinimumMet, thresholdLabel } from '../domain/rules';

export default function OperationsView() {
  const { t, tx } = useLanguage();
  const { sailings, materials, audit, suspendSailing } = useDemo();
  const { toast, openModal } = useUi();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('all');
  const [directionFilter, setDirectionFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = sailings.filter(s =>
    (statusFilter === 'all' || s.ops.toLowerCase().includes(statusFilter)) &&
    (directionFilter === 'all' || s.dir.toLowerCase() === directionFilter));
  const selected = sailings.find(s => s.id === selectedId);
  const pendingMaterials = materials.filter(m => /pending/i.test(m.status)).length;

  const metrics: ReadonlyArray<{ icon: IconName; label: string; value: number; foot: string }> = [
    { icon: 'ship', label: 'sailingsToday', value: sailings.length, foot: 'Initial times in brief; demo list' },
    { icon: 'clock', label: 'awaitMinimum', value: sailings.filter(s => !isMinimumMet(s.count)).length, foot: 'Fictional calculation' },
    { icon: 'alert', label: 'awaitOps', value: sailings.filter(s => /awaiting/i.test(s.ops)).length, foot: 'Decision not recorded' },
    { icon: 'box', label: 'materialsPending', value: pendingMaterials, foot: 'Fictional queue' },
  ];

  const askSuspend = (id: string) => openModal({
    title: t('suspend'), desc: t('reasonSuspend'), confirmText: t('confirm'), requireReason: true,
    onConfirm: reason => { suspendSailing(id, reason); toast('Demo state updated. No real sailing changed.'); },
  });

  return (
    <>
      <PageHeader titleKey="opsTitle" subKey="opsSub" />
      <div className="notice warn" style={{ marginBottom: 16 }}><strong>{t('safeTitle')}</strong>{t('opsGate')}</div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {metrics.map(m => (
          <div key={m.label} className="metric">
            <span className="metric-mark"><Icon name={m.icon} /></span>
            <div className="metric-label">{t(m.label)}</div>
            <div className="metric-value">{m.value}</div>
            <div className="metric-foot">{tx(m.foot)}</div>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-pad">
          <div className="between" style={{ flexWrap: 'wrap' }}>
            <div><h2 className="card-title">{t('sailingTable')}</h2><p className="card-desc">{tx('All counts/statuses are sample data; capacity not configured.')}</p></div>
            <div className="chip-row">
              <select className="filter-select" aria-label={tx('Filter by operations status')} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="all">{t('filterAll')}</option>
                <option value="awaiting">{tx('Awaiting approval')}</option>
                <option value="suspended">{tx('Suspended (demo)')}</option>
              </select>
              <select className="filter-select" aria-label={tx('Filter by direction')} value={directionFilter} onChange={e => setDirectionFilter(e.target.value)}>
                <option value="all">{t('filterAllDirections')}</option>
                <option value="outbound">{tx('Outbound')}</option>
                <option value="return">{tx('Return')}</option>
              </select>
            </div>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{t('time')}</th><th>{t('route')}</th><th>{t('tickets')}</th><th>{t('threshold')}</th>
              <th>{t('readiness')}</th><th>{t('manifest')}</th><th>{t('actions')}</th>
            </tr></thead>
            <tbody>
              {list.map(s => (
                <tr key={s.id}>
                  <td><strong className="mono">{s.time}</strong><div className="tiny muted">{tx(s.dir)} · {tx('demo')}</div></td>
                  <td><strong>{tx(s.dest)}</strong><div className="tiny muted">{s.id}</div></td>
                  <td>{s.count} / {s.minimum} <div className="bar"><span style={{ width: `${Math.min(100, (s.count / s.minimum) * 100)}%` }} /></div></td>
                  <td><StatusPill text={thresholdLabel(s.count)} /></td>
                  <td><StatusPill text={s.ops} /></td>
                  <td>{tx(s.manifest)}</td>
                  <td><div className="row">
                    <button type="button" className="link-btn" onClick={() => setSelectedId(s.id)}>{t('openDetail')}</button>
                    <button type="button" className="btn btn-danger btn-small" onClick={() => askSuspend(s.id)}>{t('suspend')}</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length === 0 && <div className="empty">{t('noResults')}</div>}
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        {selected && (
          <div className="card card-pad">
            <div className="between">
              <div>
                <div className="eyebrow">{tx('DEMO SAILING DETAIL')}</div>
                <h2 className="card-title"><span className="mono">{selected.id}</span> · {selected.time} · {tx(selected.dest)}</h2>
                <p className="card-desc">{tx('Passenger list is a placeholder; no real manifest is present.')}</p>
              </div>
              <button type="button" className="btn btn-outline btn-small" onClick={() => setSelectedId(null)}>{tx('Close')}</button>
            </div>
            <div className="status-grid" style={{ marginTop: 13 }}>
              <div className="status-item"><div className="status-label">{tx('Tickets / minimum')}</div><div className="status-text">{selected.count} / {selected.minimum}</div></div>
              <div className="status-item"><div className="status-label">{t('threshold')}</div><div className="status-text">{tx(thresholdLabel(selected.count))}</div></div>
              <div className="status-item"><div className="status-label">{tx('Operations')}</div><div className="status-text">{tx(selected.ops)}</div></div>
              <div className="status-item"><div className="status-label">{t('manifest')}</div><div className="status-text">{tx(selected.manifest)}</div></div>
            </div>
            <div className="divider" />
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-outline btn-small" onClick={() => toast('Review view is simulated only.')}>{t('review')}</button>
              <button type="button" className="btn btn-outline btn-small" onClick={() => navigate('/boarding')}>{t('openManifest')}</button>
              <button type="button" className="btn btn-danger btn-small" onClick={() => askSuspend(selected.id)}>{t('suspend')}</button>
            </div>
          </div>
        )}
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card card-pad">
          <h2 className="card-title">{t('attention')}</h2>
          <div className="request-row">
            <div><div className="request-title">{t('materialQueue')}</div><div className="request-meta">{pendingMaterials} {tx('fictional request(s) to review')}</div></div>
            <button type="button" className="btn btn-outline btn-small" onClick={() => navigate('/materials')}>{t('review')}</button>
          </div>
          <div className="request-row">
            <div><div className="request-title">{t('financeQueue')}</div><div className="request-meta">{tx('Unmatched payment/refund examples only')}</div></div>
            <span className="pill pill-gold">{tx('2 demo')}</span>
          </div>
        </div>
        <div className="card card-pad">
          <h2 className="card-title">{t('audit')}</h2>
          <div className="activity" style={{ marginTop: 13 }}>
            {audit.slice(-4).reverse().map((a, i) => (
              <div key={`${a.time}-${i}`} className="activity-item"><span className="activity-marker" />
                <div><div><strong>{tx(a.actor)}</strong> · {tx(a.action)}</div><div className="activity-time">{a.time} · {tx('local demo event')}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
