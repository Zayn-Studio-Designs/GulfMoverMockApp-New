import { useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';
import { useUi } from '../context/UiContext';
import { Icon, type IconName } from './Icon';

export const NAV_ITEMS: ReadonlyArray<{ to: string; key: string; icon: IconName }> = [
  { to: '/', key: 'navBook', icon: 'navBook' },
  { to: '/bookings', key: 'navBookings', icon: 'navBookings' },
  { to: '/corporate', key: 'navCorporate', icon: 'navCorporate' },
  { to: '/operations', key: 'navOps', icon: 'navOps' },
  { to: '/boarding', key: 'navBoarding', icon: 'board' },
  { to: '/materials', key: 'navMaterials', icon: 'box' },
];

export function Layout() {
  const { lang, setLang, t } = useLanguage();
  const { resetDemoData } = useDemo();
  const { toast } = useUi();
  const { pathname } = useLocation();

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [pathname]);

  const onReset = () => {
    resetDemoData();
    toast(t('resetDone'));
  };

  return (
    <>
      <div className="demo-banner"><span className="dot" /><span>{t('demoBanner')}</span></div>
      <header className="app-header">
        <div className="header-inner">
          <div className="brand">
            <div className="brand-mark">GM</div>
            <div>
              <div className="brand-name">Gulf Mover</div>
              <div className="brand-sub">{t('brandSub')}</div>
            </div>
          </div>
          <div className="header-tag">{t('productTag')}</div>
          <div className="header-spacer" />
          <div className="head-actions">
            <div className="lang-toggle">
              <button type="button" className={lang === 'en' ? 'active' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
              <button type="button" className={lang === 'ar' ? 'active' : ''} aria-pressed={lang === 'ar'} onClick={() => setLang('ar')} lang="ar">العربية</button>
            </div>
            <div className="avatar" aria-label={t('prototypeUser')}>GM</div>
          </div>
        </div>
      </header>
      <div className="shell">
        <aside className="sidebar" aria-label={t('mainNavigation')}>
          <div className="side-label">{t('workspace')}</div>
          <nav className="nav-list" aria-label={t('mainNavigation')}>
            {NAV_ITEMS.map(item => (
              <NavLink key={item.to} to={item.to} end className={({ isActive }) => `nav-btn${isActive ? ' active' : ''}`}>
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
    </>
  );
}
