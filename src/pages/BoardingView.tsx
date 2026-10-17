import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';

export default function BoardingView() {
  const { t, tx } = useLanguage();
  const { sailings, bookings, audit, boarding, updateBoarding, addAudit, overrideBoarding } = useDemo();
  const { toast, openModal } = useUi();
  const sailing = sailings.find(s => s.id === boarding.selectedSailingId) ?? sailings[0];

  // One fictional ticket per sailing: the first scan boards it, any further scan is a duplicate.
  const scan = (repeat: boolean) => {
    if (repeat || boarding.lastScanUsed) {
      updateBoarding({ boardingMessage: 'duplicate' });
      addAudit('Demo boarding user', 'Duplicate QR scan blocked; exception required');
      toast(t('scanDuplicate'));
    } else {
      updateBoarding({ boardingMessage: 'valid', lastScanUsed: true, scanCount: Math.min(boarding.scanCount + 1, sailing.count) });
      addAudit('Demo boarding user', 'Fictional ticket scanned once');
      toast(t('scanValid'));
    }
  };

  const lookup = () => {
    const ref = boarding.manualRef.trim();
    const found = bookings.find(b => b.ref === ref);
    updateBoarding({ manualFound: found ?? { ref: ref || 'No reference entered', payment: 'No exact demo record found', boarding: 'Not verified' } });
  };

  const override = (ref: string) => openModal({
    title: t('override'), desc: t('overrideReason'), confirmText: t('confirm'), requireReason: true,
    onConfirm: reason => {
      overrideBoarding(ref, reason);
      updateBoarding({ manualFound: boarding.manualFound && { ...boarding.manualFound, boarding: 'Manual override recorded (demo)' } });
      toast('Demo override recorded locally.');
    },
  });

  const canOverride = !!boarding.manualFound && bookings.some(b => b.ref === boarding.manualFound?.ref);

  return (
    <>
      <PageHeader titleKey="boardingTitle" subKey="boardingSub" />
      <div className="notice warn" style={{ marginBottom: 15 }}><strong>{t('safeTitle')}</strong>{t('safeCopy')}</div>
      <div className="split">
        <div className="card card-pad">
          <div className="between">
            <div><h2 className="card-title">{t('selectSailing')}</h2><p className="card-desc">{sailing.id} · {tx(sailing.dest)}</p></div>
            <span className="pill pill-neutral">{tx('DEMO ONLY')}</span>
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="board-sailing">{t('selectSailing')}</label>
            <select id="board-sailing" value={boarding.selectedSailingId}
              onChange={e => updateBoarding({ selectedSailingId: e.target.value, lastScanUsed: false, scanCount: 0, boardingMessage: null })}>
              {sailings.map(s => <option key={s.id} value={s.id}>{s.time} · {tx(s.dest)}</option>)}
            </select>
          </div>
          <div className="grid grid-3" style={{ marginTop: 15 }}>
            <div className="metric"><div className="metric-label">{tx('Expected (demo)')}</div><div className="metric-value">{sailing.count}</div></div>
            <div className="metric"><div className="metric-label">{tx('Boarded (demo)')}</div><div className="metric-value">{boarding.scanCount}</div></div>
            <div className="metric"><div className="metric-label">{tx('Not boarded')}</div><div className="metric-value">{Math.max(0, sailing.count - boarding.scanCount)}</div></div>
          </div>
          <div className="scan-box" style={{ marginTop: 15 }}>
            <div className="scan-icon"><Icon name="board" /></div>
            <h2 className="card-title">{t('simulateScan')}</h2>
            <p className="card-desc">{tx('Non-functional QR placeholder; actions update local demo state only.')}</p>
            <div className="qr-fake" aria-hidden="true" />
            <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={() => scan(false)}>{t('simulateScan')}</button>
              <button type="button" className="btn btn-outline" onClick={() => scan(true)}>{t('repeatScan')}</button>
            </div>
          </div>
          {boarding.boardingMessage && (
            <div className={`scan-state${boarding.boardingMessage === 'duplicate' ? ' duplicate' : ''}`} role="status" style={{ marginTop: 13 }}>
              <strong>{t('scanTitle')}</strong>
              <p className="small">{boarding.boardingMessage === 'duplicate' ? t('scanDuplicate') : t('scanValid')}</p>
            </div>
          )}
        </div>
        <div className="card card-pad">
          <h2 className="card-title">{t('manualLookup')}</h2>
          <p className="card-desc">{tx("Manual verification requires a reference and reason. This mock doesn't connect to a ticketing system.")}</p>
          <div className="field" style={{ marginTop: 15 }}>
            <label htmlFor="manual-ref">{t('bookingRef')}</label>
            <input id="manual-ref" placeholder="GM-DEMO-0248" value={boarding.manualRef} onChange={e => updateBoarding({ manualRef: e.target.value })} />
          </div>
          <button type="button" className="btn btn-outline btn-block" style={{ marginTop: 10 }} onClick={lookup}>{t('lookup')}</button>
          {boarding.manualFound && (
            <div className="inset" style={{ marginTop: 14 }}>
              <strong className="mono">{tx(boarding.manualFound.ref)}</strong>
              <p className="small">{tx(boarding.manualFound.payment)}</p>
              <p className="small">{tx(boarding.manualFound.boarding)}</p>
              {canOverride && <button type="button" className="btn btn-danger btn-small" onClick={() => override(boarding.manualFound!.ref)}>{t('override')}</button>}
            </div>
          )}
          <div className="divider" />
          <h3 className="card-title">{t('recentScans')}</h3>
          <div className="activity" style={{ marginTop: 14 }}>
            {audit.slice(-4).reverse().map((a, i) => (
              <div key={`${a.time}-${i}`} className="activity-item"><span className="activity-marker" />
                <div><strong>{tx(a.action)}</strong><div className="activity-time">{a.time}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
