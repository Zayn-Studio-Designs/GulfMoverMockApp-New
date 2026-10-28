import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useOnboarding } from '../context/OnboardingContext';
import { listBookings, type Booking } from '../lib/bookingService';
import { ProdPageHeader, dataErrorKey } from '../components/ProductionUi';
import { useLoad } from '../components/StaffKit';
import CompanyReportsView from './CompanyReportsView';

/**
 * Production corporate workspace (`/corporate`).
 *
 * State handling (all states from `deriveOnboardingState`, never inferred
 * from membership counts alone):
 * - loading / error / signed-out: status banners, no bookings fetched.
 * - no-company: registration guidance (the ONLY state that links to register).
 * - pending / rejected / suspended / restricted / invited: truthful status
 *   card for each, no implication of access.
 * - account-suspended: no workspace function offered.
 * - approved: status card + own bookings + (admins) the company account
 *   report. A booker sees the admin-only notice, never the admin report.
 * - platform-staff: staff are directed to ATCO tooling, not company booking.
 * - multiple companies: every approved membership's organization is listed;
 *   bookings remain the caller's own (`listBookings('mine')`).
 */
export default function CorporateWorkspaceView() {
  const { t } = useLanguage();
  const { status, refresh } = useOnboarding();
  const ready = status.phase === 'ready';
  const mine = useLoad<Booking[]>(() => listBookings('mine'), [ready]);

  const memberships = ready ? (status.snapshot.memberships ?? []) : [];
  const approved = memberships.filter(m => m.organization?.status === 'approved');
  const isAdmin = approved.some(m => m.membershipRole === 'company_admin');

  const statusCard = () => {
    if (status.phase === 'loading') return <div className="card card-pad"><div role="status">{t('p4Loading')}</div></div>;
    if (status.phase === 'signed-out')
      return <div className="card card-pad"><div className="notice warn" role="status">{t('errSessionRequired')}</div></div>;
    if (status.phase === 'error')
      return (
        <div className="card card-pad">
          <div className="notice danger" role="alert">{t('onbLoadError')}</div>
          <button type="button" className="btn btn-outline btn-small" style={{ marginTop: 8 }} onClick={() => void refresh()}>{t('onbCheckStatus')}</button>
        </div>
      );
    if (status.phase === 'demo') return null;
    const kind = status.state.kind;
    if (kind === 'account-suspended')
      return <div className="card card-pad"><div className="notice danger" role="status">{t('onbSuspendedBody')}</div></div>;
    if (kind === 'no-company')
      return (
        <div className="card card-pad">
          <div className="notice warn" role="status">{t('p8CorpNoCompany')}</div>
          <p className="muted small" style={{ marginTop: 8 }}>{t('p8CorpNoCompanyBody')}</p>
          <p style={{ marginTop: 8 }}><Link className="btn btn-primary" to="/onboarding">{t('navCompany')}</Link></p>
        </div>
      );
    if (kind === 'pending' || kind === 'rejected' || kind === 'suspended' || kind === 'restricted' || kind === 'invited') {
      const key = kind === 'pending' ? 'onbPendingBody' : kind === 'rejected' ? 'onbRejectedBody'
        : kind === 'suspended' ? 'onbSuspendedCoBody' : kind === 'restricted' ? 'onbRestrictedBody' : 'onbInvitedBody';
      const title = kind === 'pending' ? 'onbPendingTitle' : kind === 'rejected' ? 'onbRejectedTitle'
        : kind === 'suspended' ? 'onbSuspendedCoTitle' : kind === 'restricted' ? 'onbRestrictedTitle' : 'onbInvitedTitle';
      return (
        <div className="card card-pad">
          <h2 className="card-title">{t(title)}</h2>
          <div className="notice warn" role="status" style={{ marginTop: 8 }}>{t(key)}</div>
          <p style={{ marginTop: 8 }}><Link className="btn btn-outline btn-small" to="/onboarding">{t('onbCheckStatus')}</Link></p>
        </div>
      );
    }
    if (kind === 'platform-staff')
      return <div className="card card-pad"><div className="notice blue" role="status">{t('onbStaffBody')}</div></div>;
    return null; // approved: no banner needed
  };

  return (
    <>
      <ProdPageHeader titleKey="p8CorpTitle" subKey="p8CorpSub" />
      {statusCard()}
      {ready && status.state.kind === 'approved' && (
        <>
          {approved.length > 1 && (
            <div className="card card-pad">
              <div className="request-meta">{t('p8CorpMultiOrg')}</div>
              {approved.map(m => (
                <div key={m.organizationId} className="request-row">
                  <div className="request-title">{m.organization?.displayName || m.organization?.legalName}</div>
                  <div className="request-meta">{t(m.membershipRole === 'company_admin' ? 'onbRoleAdmin' : 'onbRoleBooker')}</div>
                </div>
              ))}
            </div>
          )}
          <section className="card card-pad" aria-labelledby="corp-bookings">
            <h2 id="corp-bookings" className="card-title">{t('p8CorpMyBookings')}</h2>
            {mine.error && <div className="notice danger" role="alert">{t(dataErrorKey(mine.error))}</div>}
            {!mine.data && !mine.error && <div role="status">{t('p4Loading')}</div>}
            {mine.data?.length === 0 && <div className="no-data">{t('pbNoBookings')}</div>}
            {(mine.data ?? []).map(b => (
              <div key={b.id} className="request-row">
                <div>
                  <div className="request-title mono">{b.reference}</div>
                  <div className="request-meta">
                    {t('pbPassengersN').replace('{n}', String(b.passengerCount))} · {t(`p8Bk_${b.status}`)}
                  </div>
                </div>
                <Link className="btn btn-outline btn-small" to={`/bookings/${b.reference}`}>{t('pbOpen')}</Link>
              </div>
            ))}
          </section>
          {isAdmin ? (
            <CompanyReportsView />
          ) : (
            <div className="card card-pad">
              <div className="notice blue">{t('p8CompanyAdminOnly')}</div>
              <p style={{ marginTop: 8 }}>
                <Link className="btn btn-outline btn-small" to="/company/members">{t('p5Members')}</Link>
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}
