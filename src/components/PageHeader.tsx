import { useLanguage } from '../context/LanguageContext';

export function PageHeader({ titleKey, subKey, eyebrow = 'ATCO MARINE / DEMO' }: { titleKey: string; /** Omitted on pages where the first card carries the instruction (boarding desk). */ subKey?: string; eyebrow?: string }) {
  const { t, tx } = useLanguage();
  return (
    <div className="page-header">
      <div>
        <div className="eyebrow">{tx(eyebrow)}</div>
        <h1 className="page-title">{t(titleKey)}</h1>
        {subKey && <p className="page-sub">{t(subKey)}</p>}
      </div>
      <div className="header-actions"><span className="pill pill-neutral">{t('demoOnly')}</span></div>
    </div>
  );
}
