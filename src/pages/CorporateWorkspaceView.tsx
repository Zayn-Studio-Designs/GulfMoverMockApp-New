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
 * Reuses only already-connected pieces: the server-read onboarding snapshot
 * (company approval state), the caller's own bookings, the company account
 * report (admins of approved orgs) and the member-management page. A
 * non-admin booker sees status + own bookings; nothing here grants access
 * beyond what each embedded piece already enforces.
 */
export default function CorporateWorkspaceView() {
  const { t } = useLanguage();
  const { status } = useOnboarding();
  const mine = useLoad<Booking[]>(() => listBookings('mine'), []);

  const memberships =
    status.phase === 'ready' ? (status.snapshot.memberships ?? []) : [];
  const approved = memberships.filter(m => m.organization?.status === 'approved');
  const isAdmin = approved.some(m => m.membershipRole === 'company_admin');

  return (
    <>
      <ProdPageHeader titleKey="p8CorpTitle" subKey="p8CorpSub" />
      {status.phase === 'ready' && approved.length === 0 && (
        <div className="card card-pad">
          <div className="notice warn" role="status">{t('p8CorpNoCompany')}</div>
          <p className="muted small" style={{ marginTop: 8 }}>{t('p8CorpNoCompanyBody')}</p>
          <p style={{ marginTop: 8 }}>
            <Link className="btn btn-primary" to="/onboarding">{t('navCompany')}</Link>
          </p>
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
        approved.length > 0 && (
          <div className="card card-pad">
            <div className="notice blue">{t('p8CompanyAdminOnly')}</div>
            <p style={{ marginTop: 8 }}>
              <Link className="btn btn-outline btn-small" to="/company/members">{t('p5Members')}</Link>
            </p>
          </div>
        )
      )}
    </>
  );
}
