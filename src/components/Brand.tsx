import { useLanguage } from '../context/LanguageContext';
import { Icon } from './Icon';

/** App brand: ATCO Marine, built by Gulf Mover. A text wordmark, not ATCO's official logo. */
export function Brand() {
  const { t } = useLanguage();
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true"><Icon name="ship" /></div>
      <div>
        <div className="brand-name">{t('brandName')}</div>
        <div className="brand-sub">{t('brandSub')}</div>
      </div>
    </div>
  );
}
