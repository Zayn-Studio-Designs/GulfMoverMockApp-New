import { useMemo, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { Icon } from '../components/Icon';
import { formatTime } from '../domain/fleet';
import { useTicketIndex, type TicketEntry } from '../hooks/useTicketIndex';
import { useCameraScanner } from '../hooks/useCameraScanner';

/**
 * Boarding desk demo. Ticket lookups resolve against the same shared demo
 * bookings the customer app displays; boarding decisions only change local demo
 * state and would require authoritative server validation in production.
 *
 * The camera/scanner is the primary action: it comes first and owns the widest
 * area, while the sailing list, manual lookup and history sit below it.
 */
export default function BoardingView() {
  const { t, tx, lang } = useLanguage();
  const { sailings, bookings, audit, boarding, updateBoarding, boardTicket, overrideBoarding } = useDemo();
  const { toast, openModal } = useUi();
  const [cameraOn, setCameraOn] = useState(false);
  const { entries, resolve } = useTicketIndex(bookings);

  const sailing = sailings.find(s => s.id === boarding.selectedSailingId) ?? sailings[0];
  const legTime = (e: TicketEntry) => (e.leg === 'return' ? e.booking.return?.time ?? e.booking.time : e.booking.time);

  // Demo sailings represent today's departures, so tickets match on time only
  // (plus direction, so a return sailing never shows outbound-side tickets).
  const sailingEntries = useMemo(
    () => (sailing ? entries.filter(e => legTime(e) === sailing.time
      && (sailing.dir === 'Return' ? e.leg === 'return' : true)) : []),
    [entries, sailing] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const boardedCount = sailingEntries.filter(e => e.ticket.status === 'boarded').length;
  const expected = sailing?.count ?? 0;

  /** The ticket the last verification resolved, looked up in the live demo state. */
  const scanned = boarding.lastResult?.ticketId
    ? entries.find(e => e.ticket.id === boarding.lastResult!.ticketId) ?? null
    : null;

  const verify = (payload: string) => {
    const query = payload.trim();
    if (!query) { toast(t('boardUnknownTicket')); return; }
    const { entry, bookingOnly, payloadId } = resolve(query);
    if (entry) {
      const res = boardTicket(entry.ticket.id, 'scan verification');
      if (res.result === 'ok') {
        updateBoarding({ lastResult: { kind: 'valid', ref: res.booking!.ref, ticketId: entry.ticket.id }, query });
        toast(t('boardMarkedOk'));
      } else {
        updateBoarding({ lastResult: { kind: res.result, ref: res.booking?.ref ?? '', ticketId: entry.ticket.id }, query });
        toast(res.result === 'duplicate' ? t('boardDuplicateMsg') : t('boardNotEligible'));
      }
      return;
    }
    if (bookingOnly) {
      // Reference matched but no single QR: show the booking for manual override.
      updateBoarding({ lastResult: null, query });
      toast(t('detailNextBoarding'));
      return;
    }
    // Keeps the failure visible on the desk instead of only as a transient toast.
    updateBoarding({ lastResult: { kind: 'unknown', ref: '', ticketId: payloadId ?? '' }, query });
    toast(t('boardUnknownTicket'));
  };

  const { state: cameraState, videoRef } = useCameraScanner(cameraOn, payload => {
    setCameraOn(false);
    verify(payload);
  });

  const lookup = () => verify(boarding.query);
  const cameraLive = cameraState === 'active' || cameraState === 'starting';
  const cameraPill = cameraState === 'active' ? t('boardCameraActive')
    : cameraState === 'starting' ? t('boardCameraStarting')
      : t('boardCameraOff');
  const cameraPillTone = cameraState === 'active' ? 'pill-green' : cameraState === 'starting' ? 'pill-gold'
    : cameraState === 'denied' || cameraState === 'error' || cameraState === 'unsupported' ? 'pill-red' : 'pill-neutral';

  const manualOverride = (ref: string) => openModal({
    title: t('override'), desc: t('overrideReason'), confirmText: t('confirm'), requireReason: true,
    onConfirm: reason => { overrideBoarding(ref, reason); toast('Demo override recorded locally.'); },
  });

  const resultFor = () => {
    const r = boarding.lastResult;
    if (!r) return null;
    if (r.kind === 'valid') return { cls: '', text: t('boardMarkedOk') };
    if (r.kind === 'duplicate') return { cls: ' duplicate', text: t('boardDuplicateMsg') };
    if (r.kind === 'notEligible') return { cls: ' duplicate', text: t('boardNotEligible') };
    return { cls: ' duplicate', text: t('boardUnknownTicket') };
  };
  const result = resultFor();

  return (
    <div className="board-screen">
      <PageHeader titleKey="boardingTitle" eyebrow="ATCO MARINE / BOARDING DESK" />

      {/* Primary action: the scanner, with nothing competing above it. */}
      <section className="card board-scan" aria-labelledby="board-scan-title">
        <div className="board-scan-head">
          <div className="board-scan-copy">
            <h2 className="board-scan-title" id="board-scan-title">{t('boardScanLead')}</h2>
            <p className="board-scan-lead">{t('boardScanQuick')}</p>
          </div>
          <span className={`pill ${cameraPillTone}`}>{cameraPill}</span>
        </div>

        <div className={`scan-preview${cameraLive ? ' live' : ''}`}>
          {cameraLive
            ? <video ref={videoRef} className="scan-video" playsInline aria-label={t('boardStartCamera')} />
            : (
              // The idle frame is itself the scan affordance, so the primary action stays in the
              // first viewport even on short phones where the button row sits just below the fold.
              <button type="button" className="scan-idle" onClick={() => setCameraOn(true)} aria-label={t('boardStartCamera')}>
                <Icon name="board" /><span>{t('boardStartCamera')}</span>
              </button>
            )}
          <span className="scan-guide" aria-hidden="true" />
        </div>

        <div className="board-scan-actions">
          <button type="button" className="btn btn-primary" onClick={() => setCameraOn(true)}>{t('boardStartCamera')}</button>
          {cameraOn && <button type="button" className="btn btn-outline" onClick={() => setCameraOn(false)}>{t('boardStopCamera')}</button>}
        </div>
        {(cameraState === 'denied' || cameraState === 'unsupported') && (
          <div className="notice warn board-scan-notice" role="status">
            {cameraState === 'denied' ? t('boardCameraDenied') : t('boardCameraUnsupported')}
          </div>
        )}

        {result && (
          <div className={`scan-state${result.cls}`} role="status" aria-live="polite">
            <div className="scan-state-head">
              <strong>{t('boardResultTitle')}</strong>
              {scanned && <StatusPill text={scanned.ticket.status === 'boarded' ? 'Boarded (demo)' : 'Not boarded'} />}
            </div>
            <p className="scan-state-text">{result.text}</p>
            {scanned && (
              <dl className="scan-facts">
                <div><dt>{t('ticketPassenger')}</dt><dd>{tx(scanned.ticket.passengerName) || t('notProvided')}</dd></div>
                <div><dt>{t('ticketIdLabel')}</dt><dd className="mono">{scanned.ticket.id}</dd></div>
                <div><dt>{t('leg')}</dt><dd>{scanned.leg === 'return' ? t('returnLeg') : t('outboundLeg')}</dd></div>
                <div><dt>{t('destination')}</dt><dd>{tx(scanned.booking.dest)}</dd></div>
                <div><dt>{t('departureTime')}</dt><dd>{scanned.legDate} · <span className="mono">{formatTime(scanned.legTime, lang)}</span></dd></div>
                <div><dt>{t('bookingRef')}</dt><dd className="mono">{scanned.booking.ref}</dd></div>
              </dl>
            )}
          </div>
        )}
      </section>

      <div className="board-layout">
        <div className="card card-pad">
          <div className="between">
            <div><h2 className="card-title">{t('selectSailing')}</h2><p className="card-desc">{sailing ? `${sailing.id} · ${tx(sailing.dest)}` : ''}</p></div>
            <span className="pill pill-neutral">{tx('DEMO ONLY')}</span>
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="board-sailing">{t('selectSailing')}</label>
            <select id="board-sailing" value={boarding.selectedSailingId}
              onChange={e => updateBoarding({ selectedSailingId: e.target.value })}>
              {sailings.map(s => <option key={s.id} value={s.id}>{formatTime(s.time, lang)} · {tx(s.dest)}</option>)}
            </select>
          </div>
          <div className="grid grid-3" style={{ marginTop: 15 }}>
            <div className="metric"><div className="metric-label">{tx('Expected (demo)')}</div><div className="metric-value">{expected}</div></div>
            <div className="metric"><div className="metric-label">{tx('Boarded (demo)')}</div><div className="metric-value">{boardedCount}</div></div>
            <div className="metric"><div className="metric-label">{tx('Not boarded')}</div><div className="metric-value">{Math.max(0, expected - boardedCount)}</div></div>
          </div>

          {/* Real ticket list for the selected sailing (shared demo state). */}
          <h3 className="card-title" style={{ marginTop: 17 }}>{t('boardTicketsList')}</h3>
          {sailingEntries.length === 0 ? (
            <div className="no-data" style={{ marginTop: 10 }}>{tx('No ticket records exist for this demo sailing yet.')}</div>
          ) : (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table style={{ minWidth: 0 }}>
                <thead><tr><th>{t('ticketPassenger')}</th><th>{t('ticketIdLabel')}</th><th>{t('ticketState')}</th></tr></thead>
                <tbody>
                  {sailingEntries.map(e => (
                    <tr key={e.ticket.id}>
                      <td data-label={t('ticketPassenger')}>{tx(e.ticket.passengerName) || t('notProvided')}</td>
                      <td data-label={t('ticketIdLabel')}><span className="mono tiny">{e.ticket.id}</span></td>
                      <td data-label={t('ticketState')}><StatusPill text={e.ticket.status === 'boarded' ? t('ticketBoarded') : t('ticketNotBoarded')} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card card-pad">
          <h2 className="card-title">{t('manualLookup')}</h2>
          <p className="card-desc">{t('boardScanSub')}</p>
          <div className="field" style={{ marginTop: 15 }}>
            <label htmlFor="manual-ref">{t('boardQuery')}</label>
            <input id="manual-ref" placeholder="GM-VERIFY-1|GMTK…" value={boarding.query}
              onChange={e => updateBoarding({ query: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') lookup(); }} />
          </div>
          <button type="button" className="btn btn-outline btn-block" style={{ marginTop: 10 }} onClick={lookup}>{t('boardVerify')}</button>
          <button type="button" className="btn btn-outline btn-small" style={{ marginTop: 12 }}
            onClick={() => manualOverride(boarding.query.trim().toUpperCase())}>{t('override')}</button>
          <div className="divider" />
          <h3 className="card-title">{t('recentScans')}</h3>
          <div className="activity" style={{ marginTop: 14 }}>
            {audit.slice(-4).reverse().map((a, i) => (
              <div key={`${a.time}-${i}`} className="activity-item"><span className="activity-marker" />
                <div><strong>{tx(a.action)}</strong><div className="activity-time">{a.time}</div></div>
              </div>
            ))}
          </div>
          <div className="divider" />
          <div className="notice warn"><strong>{t('safeTitle')}</strong>{t('boardScanGate')}</div>
        </div>
      </div>
    </div>
  );
}
