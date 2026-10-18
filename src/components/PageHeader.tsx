import { useLanguage } from '../context/LanguageContext';

export function PageHeader({ titleKey, subKey, eyebrow = 'ATCO MARINE / DEMO' }: { titleKey: string; subKey: string; eyebrow?: string }) {
  const { t, tx } = useLanguage();
  return (
    <div className="page-header">
      <div>
        <div className="eyebrow">{tx(eyebrow)}</div>
        <h1 className="page-title">{t(titleKey)}</h1>
        <p className="page-sub">{t(subKey)}</p>
      </div>
      <div className="header-actions"><span className="pill pill-neutral">{t('demoOnly')}</span></div>
    </div>
  );
}
