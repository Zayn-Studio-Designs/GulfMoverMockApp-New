import { Link, useLocation } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { ATCO_CONTACT } from '../data/demoData';
import { ArrowIcon, Icon } from './Icon';

/** Path of the ATCO information panel in Settings (the only place the full details are shown). */
export const ATCO_INFO_PATH = '/settings?tab=atco';

/**
 * Compact "Contact ATCO" entry for the bottom of a page. Opens Settings → ATCO information and
 * remembers where it came from, so that panel can offer a way back.
 */
export function ContactAtcoLink() {
  const { t } = useLanguage();
  const { pathname, search } = useLocation();
  return (
    <div className="contact-atco-row">
      <Link className="contact-atco-link" to={ATCO_INFO_PATH} state={{ from: pathname + search }}>
        <Icon name="company" /><span>{t('contactTitle')}</span><ArrowIcon />
      </Link>
    </div>
  );
}

/** ATCO contact details (Settings → ATCO information). Details come from ATCO's public contact page and must be confirmed before go-live. */
export function ContactCard({ compact = false }: { compact?: boolean }) {
  const { t, lang } = useLanguage();
  const c = ATCO_CONTACT;
  return (
    <section className={`card card-pad contact-card${compact ? ' compact' : ''}`} aria-labelledby="atco-contact">
      <div className="between">
        <div>
          <h2 id="atco-contact" className="card-title">{t('contactTitle')}</h2>
          <p className="card-desc">{c.company[lang]}</p>
        </div>
        <span className="pill pill-gold">{t('contactVerify')}</span>
      </div>
      <dl className="contact-grid">
        <div><dt>{t('contactPhone')}</dt><dd><a href={`tel:${c.phone.replace(/\s/g, '')}`} dir="ltr">{c.phone}</a></dd></div>
        <div><dt>{t('contactMarineEmail')}</dt><dd><a href={`mailto:${c.marineEmail}`} dir="ltr">{c.marineEmail}</a></dd></div>
        <div><dt>{t('contactWebsite')}</dt><dd><a href={`https://${c.website}`} target="_blank" rel="noreferrer" dir="ltr">{c.website}</a></dd></div>
        <div><dt>{t('contactAddress')}</dt><dd>{c.address[lang]}</dd></div>
      </dl>
      <p className="tiny muted" style={{ margin: '12px 0 0' }}>{t('builtBy')}</p>
    </section>
  );
}
