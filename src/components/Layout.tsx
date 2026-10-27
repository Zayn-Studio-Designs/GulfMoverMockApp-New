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
import { useOnboarding, usePlatformRoles } from '../context/OnboardingContext';
import { Icon, type IconName } from './Icon';
import { Tour, hasSeenTour, markTourSeen } from './Tour';
import { ErrorBoundary } from './ErrorBoundary';

interface NavItem {
  to: string;
  key: string;
  icon: IconName;
  /** Phone-only entry: the desktop staff sidebar keeps its existing destinations. */
  mobileOnly?: boolean;
  /** Desktop-only entry: the phone staff bar shows the six destinations a crew needs on site. */
  desktopOnly?: boolean;
  /** The phone staff entry that opens the Agent Ops chooser instead of a single page. */
  hub?: boolean;
}

/** Destinations grouped behind the phone staff “Agent Ops” entry; both pages keep their own routes. */
const AGENT_OPS_LINKS: ReadonlyArray<NavItem> = [
  { to: '/corporate', key: 'navCorporate', icon: 'navCorporate' },
  { to: '/operations', key: 'navOps', icon: 'navOps' },
];

/**
 * Navigation shown to each demo view. Navigation filtering is UI-only: every route
 * stays reachable by URL and the demo banner carries the no-real-permissions notice.
 */
export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { to: '/', key: 'navHome', icon: 'home', mobileOnly: true },
  { to: '/book', key: 'navBook', icon: 'navBook', desktopOnly: true },
  { to: '/bookings', key: 'navBookings', icon: 'navBookings' },
  { to: '/corporate', key: 'navCorporate', icon: 'navCorporate', desktopOnly: true },
  { to: '/operations', key: 'navOps', icon: 'navOps', desktopOnly: true },
  // Phone-only stand-in for those two pages, in the position the six-entry bar expects.
  { to: '#agent-ops', key: 'navAgentOps', icon: 'grid', hub: true, mobileOnly: true },
  { to: '/boarding', key: 'navBoarding', icon: 'board' },
  { to: '/materials', key: 'navMaterials', icon: 'box' },
  { to: '/fleet', key: 'navFleet', icon: 'ship' },
];

/** Customer destinations: only what a booking customer needs every day. */
const CUSTOMER_NAV: ReadonlyArray<NavItem> = [
  { to: '/', key: 'navHome', icon: 'home' },
  { to: '/book', key: 'navBook', icon: 'navBook' },
  { to: '/bookings', key: 'navBookings', icon: 'navBookings' },
  { to: '/settings', key: 'navAccount', icon: 'user' },
];

/** Production navigation: only Supabase-backed destinations. */
const PRODUCTION_CUSTOMER_NAV: ReadonlyArray<NavItem> = [
  { to: '/onboarding', key: 'navCompany', icon: 'navCorporate' },
  { to: '/book', key: 'navBook', icon: 'navBook' },
  { to: '/bookings', key: 'navBookings', icon: 'navBookings' },
  { to: '/settings', key: 'navAccount', icon: 'user' },
];
/** ATCO destinations, shown only when the SERVER-READ platform roles include one of `roles`. */
const PRODUCTION_STAFF_NAV: ReadonlyArray<NavItem & { roles: readonly string[] }> = [
  { to: '/admin/companies', key: 'navReview', icon: 'list', roles: ['super_admin', 'operations'] },
  { to: '/admin/operations', key: 'navAdminOps', icon: 'ship', roles: ['super_admin', 'operations'] },
  { to: '/admin/boarding', key: 'p4Boarding', icon: 'board', roles: ['super_admin', 'operations', 'boarding_staff'] },
];

/**
 * Production only: states plainly which parts of the app are live, and the user's next
 * onboarding step. Demo-data screens are never presented as connected production features.
 */
function ProductionScopeNotice() {
  const { t } = useLanguage();
  const { status } = useOnboarding();
  const needsCompany = status.phase === 'ready' && status.state.kind === 'no-company';
  return (
    <div className={`notice ${needsCompany ? 'blue' : 'warn'}`} role="note" style={{ marginBottom: 18 }}>
      {needsCompany && <strong>{t('prodNextRegister')}</strong>}
      {t('prodScopeNotice')}{' '}
      <Link to="/onboarding">{t('prodStatusLink')}</Link>
    </div>
  );
}

/**
 * Profile button with a small menu: account details, Settings and Sign out. Company details live in
 * Settings, notifications in the header bell, the demo view switch in the side panel and the tour
 * behind the ? button, so none of them is repeated here.
 */
function AccountMenu() {
  const { t, lang, setLang } = useLanguage();
  const { user, signOut } = useAuth();
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
          <Link role="menuitem" className="account-item" to="/settings?tab=security" onClick={() => setOpen(false)}>{t('securityTab')}</Link>
          {/* Language lives here now, between Security and All settings. The menu stays open so
              the whole menu switches language in place. */}
          <div className="account-lang" data-tour="language">
            <span className="account-lang-label">{t('languageTitle')}</span>
            <div className="lang-toggle" role="group" aria-label={t('languageTitle')}>
              <button type="button" className={lang === 'en' ? 'active' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
              <button type="button" className={lang === 'ar' ? 'active' : ''} aria-pressed={lang === 'ar'} onClick={() => setLang('ar')} lang="ar">العربية</button>
            </div>
          </div>
          <Link role="menuitem" className="account-item" to="/settings?tab=preferences" onClick={() => setOpen(false)}>{t('settingsLink')}</Link>
          <div className="account-sep" />
          <button role="menuitem" type="button" className="account-item account-signout" onClick={async () => {
            setOpen(false);
            // Only claim "signed out" once the session has really ended; a failure keeps the user signed in.
            const err = await signOut();
            if (err) { toast(t(err)); return; }
            toast(t('signedOut'));
            navigate('/signin');
          }}>{t('signOut')}</button>
        </div>
      )}
    </div>
  );
}

/** Shown in place of a page that failed to render; the header and menu stay usable. */
function ScreenError({ retry }: { retry: () => void }) {
  const { t } = useLanguage();
  const { resetDemoData } = useDemo();
  return (
    <div className="card card-pad screen-error" role="alert">
      <h1 className="page-title">{t('screenErrorTitle')}</h1>
      <p className="muted">{t('screenErrorBody')}</p>
      <div className="crash-actions">
        <button type="button" className="btn btn-primary" onClick={retry}>{t('screenErrorRetry')}</button>
        <button type="button" className="btn btn-outline" onClick={() => { resetDemoData(); retry(); }}>{t('resetDemo')}</button>
      </div>
    </div>
  );
}

/** Production-only blocking screens inside the layout: config error and session restore. */
function ProductionAuthScreen({ loading }: { loading: boolean }) {
  const { t } = useLanguage();
  const { authUnavailable } = useAuth();
  return (
    <main id="app-main" tabIndex={-1} style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      {loading ? (
        <div className="card card-pad" role="status">{t('authLoading')}</div>
      ) : (
        <div className="card card-pad" role="alert" style={{ maxWidth: 640 }}>
          <h1 className="page-title">{t('authConfigErrorTitle')}</h1>
          <div className="notice danger">{t('authConfigErrorBody')}</div>
          <div className="inset small">
            <strong>{t('authConfigIssueLabel')}</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
              {(authUnavailable?.issues ?? []).map(issue => <li key={issue}><code dir="ltr">{issue}</code></li>)}
            </ul>
          </div>
        </div>
      )}
    </main>
  );
}

export function Layout() {
  const { t } = useLanguage();
  const { user, signedOutByUser, authMode, sessionLoading, authUnavailable } = useAuth();
  const isDemoAuth = authMode === 'demo';
  const { isCustomer, setMode } = useWorkMode();
  const { resetDemoData } = useDemo();
  const { toast } = useUi();
  const { pathname, search } = useLocation();
  const [tourOpen, setTourOpen] = useState(false);
  const [hubOpen, setHubOpen] = useState(false);
  const hubRef = useRef<HTMLDivElement>(null);
  const hubTriggerRef = useRef<HTMLButtonElement>(null);
  const agentOpsActive = pathname === '/corporate' || pathname === '/operations';

  // The Agent Ops chooser groups the two staff pages on the phone bar. It closes on navigation,
  // Escape or a tap outside it — the same dismissal the profile menu uses.
  useEffect(() => { setHubOpen(false); }, [pathname]);
  useEffect(() => {
    if (!hubOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      const target = e.target as Node;
      if (hubRef.current?.contains(target) || hubTriggerRef.current?.contains(target)) return;
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      setHubOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [hubOpen]);

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [pathname]);

  // On phones the navigation row scrolls sideways once the staff view has more destinations than
  // fit, so bring the active one into view after every navigation or view change.
  useEffect(() => {
    const list = document.querySelector<HTMLElement>('.nav-list');
    if (!list || list.scrollWidth <= list.clientWidth) return;
    list.querySelector<HTMLElement>('.nav-btn.active')?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [pathname, isCustomer]);

  // Each step opens its own page, so the tour can start from anywhere.
  const startTour = useCallback(() => setTourOpen(true), []);
  const closeTour = useCallback(() => setTourOpen(false), []);

  // New accounts get the tour once, on their first visit; the demo guest can start it from the ? button.
  // The tour follows the current demo view, and restarts from step 1 if the view is switched.
  // It describes demo screens, so production never starts it.
  const userId = user?.id;
  const isGuest = user?.email === DEMO_GUEST.email;
  const platformRoles = usePlatformRoles();
  const navItems: ReadonlyArray<NavItem> = isDemoAuth
    ? (isCustomer ? CUSTOMER_NAV : NAV_ITEMS)
    : [...PRODUCTION_CUSTOMER_NAV, ...PRODUCTION_STAFF_NAV.filter(item => platformRoles?.some(r => item.roles.includes(r)))];
  useEffect(() => {
    if (!isDemoAuth || !userId || isGuest || hasSeenTour(userId)) return;
    markTourSeen(userId);
    startTour();
  }, [isDemoAuth, userId, isGuest, startTour]);

  const publicAtcoInfo = pathname === '/settings' && new URLSearchParams(search).get('tab') === 'atco';
  // Production gates run BEFORE any redirect: restoring a session or a broken
  // configuration must never bounce the user to /signin or show demo screens.
  if (!isDemoAuth) {
    if (authUnavailable) return <ProductionAuthScreen loading={false} />;
    if (sessionLoading && !user) return <ProductionAuthScreen loading />;
  }
  if (!user && !publicAtcoInfo) return <Navigate to="/signin" replace state={signedOutByUser ? undefined : { from: pathname }} />;

  const onReset = () => {
    resetDemoData();
    toast(t('resetDone'));
  };

  return (
    <>
      <div className="demo-banner"><span className="dot" /><span>{isDemoAuth ? t('demoBanner') : t('prodBanner')}</span></div>
      <header className="app-header">
        <div className="header-inner">
          <Brand />
          <div className="header-tag">{t('productTag')}</div>
          <div className="header-spacer" />
          <div className="head-actions">
            {/* Signed-out visitors can open only the public ATCO page; the tour needs an account. */}
            {user && isDemoAuth && <button type="button" className="tour-btn" data-tour="account" aria-label={t('tourStart')} title={t('tourStart')} onClick={startTour}>?</button>}
            {/* Opens the same Notifications settings page the profile menu used to link to. */}
            {user && <Link className="bell-btn" to="/settings?tab=notifications" aria-label={t('notificationsTitle')} title={t('notificationsTitle')}><Icon name="bell" /></Link>}
            <AccountMenu />
          </div>
        </div>
      </header>
      <div className="shell">
        <aside className="sidebar" aria-label={t('mainNavigation')}>
          <div className="side-label">{t('workspace')}</div>
          {/* The customer/staff switch is a demo presentation aid. Production never offers it:
              ATCO screens appear only for accounts whose server-side roles allow them. */}
          {isDemoAuth && (
            <div className="ws-switch" role="group" data-tour="ws-switch" aria-label={t('wsSwitchGroup')}>
              <div className="ws-seg">
                <button type="button" className={`ws-btn${isCustomer ? ' active' : ''}`} aria-pressed={isCustomer} onClick={() => setMode('customer')}>{t('wsCustomerLabel')}</button>
                <button type="button" className={`ws-btn${isCustomer ? '' : ' active'}`} aria-pressed={!isCustomer} onClick={() => setMode('staff')}>{t('wsStaffLabel')}</button>
              </div>
              <small>{t('wsDemoHint')}</small>
            </div>
          )}
          <nav className={`nav-list${isCustomer || !isDemoAuth ? '' : ' nav-list-staff'}`} aria-label={t('mainNavigation')} data-tour="nav">
            {navItems.map(item => item.hub ? (
              <button key={item.key} type="button" ref={hubTriggerRef} data-tour={`nav-${item.key}`}
                className={`nav-btn nav-hub${agentOpsActive ? ' active' : ''}${item.mobileOnly ? ' nav-mobile-only' : ''}`}
                aria-haspopup="menu" aria-expanded={hubOpen} onClick={() => setHubOpen(open => !open)}>
                <Icon name={item.icon} />
                <span className="nav-full">{t(item.key)}</span>
                <span className="nav-short">{t(`${item.key}Short`)}</span>
              </button>
            ) : (
              <NavLink key={item.to} to={item.to} end className={({ isActive }) => `nav-btn${isActive ? ' active' : ''}${item.mobileOnly ? ' nav-mobile-only' : ''}${item.desktopOnly ? ' nav-desktop-only' : ''}`}
                data-tour={`nav-${item.key}`}>
                <Icon name={item.icon} />
                <span className="nav-full">{t(item.key)}</span>
                <span className="nav-short">{t(`${item.key}Short`)}</span>
              </NavLink>
            ))}
          </nav>
          {/* Phone-only chooser: both underlying pages keep their own routes and demo state. */}
          {hubOpen && !isCustomer && (
            <div className="nav-hub-pop" role="menu" aria-label={t('navAgentOps')} ref={hubRef}>
              {AGENT_OPS_LINKS.map(item => (
                <Link key={item.to} role="menuitem" className="nav-hub-item" to={item.to} onClick={() => setHubOpen(false)}>
                  <Icon name={item.icon} />
                  <span>{t(item.key)}</span>
                </Link>
              ))}
            </div>
          )}
          {isDemoAuth && <div className="side-note"><strong>{t('sampleWorkspace')}</strong><span>{t('demoSideNote')}</span></div>}
          {isDemoAuth && <button type="button" className="side-reset" onClick={onReset}><Icon name="reset" />{t('resetDemo')}</button>}
        </aside>
        <main className="main" id="app-main" tabIndex={-1}>
          {!isDemoAuth && user && pathname !== '/onboarding' && <ProductionScopeNotice />}
          <ErrorBoundary resetKey={pathname} fallback={retry => <ScreenError retry={retry} />}>
            <Outlet />
          </ErrorBoundary>
          {isDemoAuth && <button type="button" className="mobile-reset" onClick={onReset}><Icon name="reset" />{t('resetDemo')}</button>}
        </main>
      </div>
      {tourOpen && user && <Tour key={isCustomer ? 'customer' : 'staff'} mode={isCustomer ? 'customer' : 'staff'} onClose={closeTour} />}
    </>
  );
}
