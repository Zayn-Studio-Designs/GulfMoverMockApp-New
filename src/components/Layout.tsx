import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { DEMO_GUEST, useAuth } from '../context/AuthContext';
import { Avatar } from './Avatar';
import { Brand } from './Brand';
import { CompanyLogo } from './ImageUpload';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';
import { useWorkMode } from '../context/WorkModeContext';
import { useUi } from '../context/UiContext';
import { Icon, type IconName } from './Icon';
import { Tour, hasSeenTour, markTourSeen } from './Tour';

/**
 * Navigation shown to each demo view. Navigation filtering is UI-only: every route
 * stays reachable by URL and the demo banner carries the no-real-permissions notice.
 */
export const NAV_ITEMS: ReadonlyArray<{ to: string; key: string; icon: IconName }> = [
  { to: '/book', key: 'navBook', icon: 'navBook' },
  { to: '/bookings', key: 'navBookings', icon: 'navBookings' },
  { to: '/corporate', key: 'navCorporate', icon: 'navCorporate' },
  { to: '/operations', key: 'navOps', icon: 'navOps' },
  { to: '/boarding', key: 'navBoarding', icon: 'board' },
  { to: '/materials', key: 'navMaterials', icon: 'box' },
  { to: '/fleet', key: 'navFleet', icon: 'ship' },
];

/** Customer destinations: only what a booking customer needs every day. */
const CUSTOMER_NAV: ReadonlyArray<{ to: string; key: string; icon: IconName }> = [
  { to: '/', key: 'navHome', icon: 'home' },
  { to: '/book', key: 'navBook', icon: 'navBook' },
  { to: '/bookings', key: 'navBookings', icon: 'navBookings' },
  { to: '/settings', key: 'navAccount', icon: 'user' },
];

/** Profile button with a small menu: account details, Settings, the guided tour and Sign out. */
function AccountMenu({ onTour }: { onTour: () => void }) {
  const { t } = useLanguage();
  const { user, signOut } = useAuth();
  const { isCustomer, setMode } = useWorkMode();
  const { toast } = useUi();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  if (!user) return null;
  return (
    <div className="account-menu" ref={ref} data-tour="account">
      <button type="button" className="account-btn" aria-haspopup="menu" aria-expanded={open} aria-label={t('accountMenu')} onClick={() => setOpen(o => !o)}>
        <Avatar user={user} />
      </button>
      {open && (
        <div className="account-pop" role="menu">
          <div className="account-who">
            <Avatar user={user} size={40} />
            <div style={{ minWidth: 0 }}>
              <strong>{user.fullName || user.username}</strong>
              <span className="account-co"><CompanyLogo company={user.company} logo={user.companyLogo} size={16} />{user.company}</span>
              <span className="muted" dir="ltr">{user.email}</span>
            </div>
          </div>
          <Link role="menuitem" className="account-item" to="/settings" onClick={() => setOpen(false)}>{t('profile')}</Link>
          <Link role="menuitem" className="account-item" to="/settings?tab=company" onClick={() => setOpen(false)}>{t('companyTitle')}</Link>
          <Link role="menuitem" className="account-item" to="/settings?tab=security" onClick={() => setOpen(false)}>{t('securityTab')}</Link>
          <Link role="menuitem" className="account-item" to="/settings?tab=notifications" onClick={() => setOpen(false)}>{t('notificationsTitle')}</Link>
          <Link role="menuitem" className="account-item" to="/settings?tab=preferences" onClick={() => setOpen(false)}>{t('settingsLink')}</Link>
          <button role="menuitem" type="button" className="account-item" onClick={() => { setOpen(false); setMode(isCustomer ? 'staff' : 'customer'); }}>
            {isCustomer ? t('wsSwitchStaff') : t('wsSwitchCustomer')}
          </button>
          <button role="menuitem" type="button" className="account-item" onClick={() => { setOpen(false); onTour(); }}>{t('tourStart')}</button>
          <div className="account-sep" />
          <button role="menuitem" type="button" className="account-item account-signout" onClick={() => { setOpen(false); signOut(); toast(t('signedOut')); navigate('/signin'); }}>{t('signOut')}</button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { lang, setLang, t } = useLanguage();
  const { user, signedOutByUser } = useAuth();
  const { isCustomer, setMode } = useWorkMode();
  const { resetDemoData } = useDemo();
  const { toast } = useUi();
  const { pathname } = useLocation();
  const [tourOpen, setTourOpen] = useState(false);

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [pathname]);

  // Each step opens its own page, so the tour can start from anywhere.
  const startTour = useCallback(() => setTourOpen(true), []);
  const closeTour = useCallback(() => setTourOpen(false), []);

  // New accounts get the tour once, on their first visit; the demo guest can start it from the ? button.
  // The tour follows the current demo view, and restarts from step 1 if the view is switched.
  const userId = user?.id;
  const isGuest = user?.email === DEMO_GUEST.email;
  useEffect(() => {
    if (!userId || isGuest || hasSeenTour(userId)) return;
    markTourSeen(userId);
    startTour();
  }, [userId, isGuest, startTour]);

  if (!user) return <Navigate to="/signin" replace state={signedOutByUser ? undefined : { from: pathname }} />;

  const onReset = () => {
    resetDemoData();
    toast(t('resetDone'));
  };

  return (
    <>
      <div className="demo-banner"><span className="dot" /><span>{t('demoBanner')}</span></div>
      <header className="app-header">
        <div className="header-inner">
          <Brand />
          <div className="header-tag">{t('productTag')}</div>
          <div className="header-spacer" />
          <div className="head-actions">
            <div className="lang-toggle" data-tour="language">
              <button type="button" className={lang === 'en' ? 'active' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
              <button type="button" className={lang === 'ar' ? 'active' : ''} aria-pressed={lang === 'ar'} onClick={() => setLang('ar')} lang="ar">العربية</button>
            </div>
            <button type="button" className="tour-btn" data-tour="account" aria-label={t('tourStart')} title={t('tourStart')} onClick={startTour}>?</button>
            <AccountMenu onTour={startTour} />
          </div>
        </div>
      </header>
      <div className="shell">
        <aside className="sidebar" aria-label={t('mainNavigation')}>
          <div className="side-label">{t('workspace')}</div>
          <div className="ws-switch" role="group" data-tour="ws-switch" aria-label={t('wsSwitchGroup')}>
            <div className="ws-seg">
              <button type="button" className={`ws-btn${isCustomer ? ' active' : ''}`} aria-pressed={isCustomer} onClick={() => setMode('customer')}>{t('wsCustomerLabel')}</button>
              <button type="button" className={`ws-btn${isCustomer ? '' : ' active'}`} aria-pressed={!isCustomer} onClick={() => setMode('staff')}>{t('wsStaffLabel')}</button>
            </div>
            <small>{t('wsDemoHint')}</small>
          </div>
          <nav className="nav-list" aria-label={t('mainNavigation')} data-tour="nav">
            {(isCustomer ? CUSTOMER_NAV : NAV_ITEMS).map(item => (
              <NavLink key={item.to} to={item.to} end className={({ isActive }) => `nav-btn${isActive ? ' active' : ''}`}
                data-tour={`nav-${item.key}`}>
                <Icon name={item.icon} />
                <span className="nav-full">{t(item.key)}</span>
                <span className="nav-short">{t(`${item.key}Short`)}</span>
              </NavLink>
            ))}
          </nav>
          <div className="side-note"><strong>{t('sampleWorkspace')}</strong><span>{t('demoSideNote')}</span></div>
          <button type="button" className="side-reset" onClick={onReset}><Icon name="reset" />{t('resetDemo')}</button>
        </aside>
        <main className="main" id="app-main" tabIndex={-1}>
          <Outlet />
          <button type="button" className="mobile-reset" onClick={onReset}><Icon name="reset" />{t('resetDemo')}</button>
        </main>
      </div>
      {tourOpen && <Tour key={isCustomer ? 'customer' : 'staff'} mode={isCustomer ? 'customer' : 'staff'} onClose={closeTour} />}
    </>
  );
}
