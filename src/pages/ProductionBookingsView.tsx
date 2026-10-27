import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { usePlatformRoles } from '../context/OnboardingContext';
import { getBooking, listBookings, type Booking } from '../lib/bookingService';
import { ProdPageHeader, SailingTime, dataErrorKey } from '../components/ProductionUi';

/**
 * Production "My bookings" (`/bookings`) and booking detail (`/bookings/:reference`).
 * Records come from the `bookings` table under RLS: the creator, their company admin and ATCO
 * operations can see a booking — nobody else, whatever reference they type into the URL.
 * Every status shown is the server's; payment, clearance and boarding are not connected.
 */

function legLabel(t: (k: string) => string, leg: 'outbound' | 'return') {
  return leg === 'return' ? t('pbReturn') : t('pbOutbound');
}

function StatusGrid() {
  const { t } = useLanguage();
  const rows: Array<[string, string, string]> = [
    ['pbStatusReservation', 'pbStatusReserved', 'pill-green'],
    ['pbStatusPayment', 'pbStatusNotConnected', 'pill-neutral'],
    ['pbStatusOps', 'pbStatusNotConnected', 'pill-neutral'],
    ['pbStatusBoarding', 'pbStatusNotConnected', 'pill-neutral'],
  ];
  return (
    <div className="status-grid" style={{ marginTop: 14 }}>
      {rows.map(([label, value, tone]) => (
        <div key={label} className="status-item">
          <div className="status-label">{t(label)}</div>
          <div className="status-text"><span className={`pill ${tone}`}>{t(value)}</span></div>
        </div>
      ))}
    </div>
  );
}

function BookingDetail({ reference }: { reference: string }) {
  const { t } = useLanguage();
  const [booking, setBooking] = useState<Booking | null | undefined>(undefined);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    setBooking(undefined);
    try { setBooking(await getBooking(reference)); } catch (e) { setError(dataErrorKey(e)); }
  }, [reference]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <ProdPageHeader titleKey="pbDetailTitle" />
      <div style={{ marginBottom: 12 }}><Link to="/bookings" className="link-btn">← {t('pbBackToList')}</Link></div>
      {error && <div className="notice danger" role="alert">{t(error)} <button type="button" className="link-btn" onClick={() => void load()}>{t('screenErrorRetry')}</button></div>}
      {!error && booking === undefined && <div className="card card-pad" role="status">{t('pbLoadingBookings')}</div>}
      {!error && booking === null && <div className="card card-pad"><div className="notice warn" role="alert">{t('pbNotFound')}</div></div>}
      {booking && (
        <section className="card card-pad" aria-labelledby="pb-detail-ref">
          <div className="between">
            <h2 id="pb-detail-ref" className="card-title">{t('pbReference')}: <span className="mono">{booking.reference}</span></h2>
            <button type="button" className="btn btn-outline btn-small" onClick={() => void load()}>{t('pbRefresh')}</button>
          </div>
          <StatusGrid />
          <div className="notice warn" style={{ marginTop: 14 }}>{t('pbNotPaidNotice')}</div>
          <div style={{ marginTop: 14 }}>
            {booking.legs.map(leg => (
              <div key={leg.leg} className="request-row">
                <div>
                  <div className="request-title">{legLabel(t, leg.leg)} · {leg.sailing ? `${leg.sailing.origin} → ${leg.sailing.destination}` : '—'}</div>
                  <div className="request-meta">{leg.sailing ? <SailingTime iso={leg.sailing.departsAt} /> : null} · {leg.sailing?.vesselName}</div>
                </div>
                <div className="row">
                  {leg.sailing && leg.sailing.status !== 'open' && <span className="pill pill-red">{t(leg.sailing.status === 'cancelled' ? 'opsStatusCancelled' : 'opsStatusClosed')}</span>}
                  <span className="pill pill-neutral">{t('pbPassengersN').replace('{n}', String(leg.passengers))}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="inset small" style={{ marginTop: 14 }}>
            <div className="between"><span className="muted">{t('pbLeadName')}</span><strong>{booking.contactName}</strong></div>
            <div className="between" style={{ marginTop: 6 }}><span className="muted">{t('pbContactEmail')}</span><strong dir="ltr">{booking.contactEmail}</strong></div>
            <div className="between" style={{ marginTop: 6 }}><span className="muted">{t('pbContactPhone')}</span><strong dir="ltr">{booking.contactPhone}</strong></div>
            {booking.passengerNames.length > 1 && (
              <div className="between" style={{ marginTop: 6 }}><span className="muted">{t('pbExtraNames')}</span><strong>{booking.passengerNames.slice(1).join(', ')}</strong></div>
            )}
            {booking.poReference && <div className="between" style={{ marginTop: 6 }}><span className="muted">{t('pbPo')}</span><strong>{booking.poReference}</strong></div>}
          </div>
        </section>
      )}
    </>
  );
}

function BookingList() {
  const { t } = useLanguage();
  const roles = usePlatformRoles();
  // ATCO staff can see every booking under RLS; "My bookings" still means their own. Nothing is
  // requested until the roles are known, so a staff list never briefly shows everyone's bookings.
  const scope = roles === null ? null : roles.length > 0 ? 'mine' : 'visible';
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (scope === null) return;
    setError('');
    try { setBookings(await listBookings(scope)); } catch (e) { setBookings(null); setError(dataErrorKey(e)); }
  }, [scope]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <ProdPageHeader titleKey="pbListTitle" subKey="pbListSub" />
      {error && <div className="notice danger" role="alert">{t(error)} <button type="button" className="link-btn" onClick={() => void load()}>{t('screenErrorRetry')}</button></div>}
      {!error && bookings === null && <div className="card card-pad" role="status">{t('pbLoadingBookings')}</div>}
      {bookings && bookings.length === 0 && (
        <div className="card card-pad"><div className="empty"><p>{t('pbNoBookings')}</p><Link className="btn btn-primary" to="/book">{t('pbBookCta')}</Link></div></div>
      )}
      {bookings && bookings.length > 0 && (
        <section className="card card-pad">
          {bookings.map(b => {
            const outbound = b.legs.find(l => l.leg === 'outbound');
            return (
              <div key={b.id} className="request-row">
                <div>
                  <div className="request-title"><span className="mono">{b.reference}</span> · {outbound?.sailing ? `${outbound.sailing.origin} → ${outbound.sailing.destination}` : '—'}</div>
                  <div className="request-meta">
                    {outbound?.sailing ? <SailingTime iso={outbound.sailing.departsAt} /> : null}
                    {' · '}{t('pbPassengersN').replace('{n}', String(b.passengerCount))}
                    {b.legs.length > 1 ? ` · ${t('pbWithReturn')}` : ''}
                  </div>
                </div>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <span className="pill pill-green">{t('pbStatusReserved')}</span>
                  <Link className="btn btn-outline btn-small" to={`/bookings/${b.reference}`}>{t('pbOpen')}</Link>
                </div>
              </div>
            );
          })}
        </section>
      )}
    </>
  );
}

export default function ProductionBookingsView() {
  const { reference } = useParams();
  return reference ? <BookingDetail reference={reference} /> : <BookingList />;
}
