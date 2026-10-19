import { useLanguage } from '../context/LanguageContext';

/** App brand: ATCO Marine. Uses the official ATCO Marine logo asset. */
export function Brand() {
  const { t } = useLanguage();
  return (
    <div className="brand">
      <div className="brand-mark">
        <img
          src="/assets/logos/atco-marine-logo.png"
          alt="ATCO Marine"
          className="brand-logo"
        />
      </div>
      <div>
        <div className="brand-name">{t('brandName')}</div>
        <div className="brand-sub">{t('brandSub')}</div>
      </div>
    </div>
  );
}
