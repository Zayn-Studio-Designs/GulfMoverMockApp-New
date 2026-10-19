import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';
import { StatusPill } from '../components/StatusPill';
import { ArrowIcon, Icon } from '../components/Icon';
import { ContactCard } from '../components/ContactCard';
import { formatTime } from '../domain/fleet';
import { BOATS, today } from '../data/demoData';

/**
 * Customer home screen. Answers the three customer questions in one glance:
 * 1) book a trip (one obvious primary action), 2) where is my next trip and
 * what state is it in, 3) where to find help and account settings.
 * Existing booking statuses are shown exactly as the demo stores them.
 */
export default function CustomerHome() {
  const { t, tx, lang } = useLanguage();
  const { bookings } = useDemo();
  const navigate = useNavigate();

  /** Earliest booking on today or a future date (demo sample + user bookings). */
  const next = useMemo(() => {
    const td = today();
    return [...bookings]
      .filter(b => b.date >= td)
      .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)))[0] ?? null;
  }, [bookings]);

  const boatName = (id?: string) => BOATS.find(b => b.id === id)?.name[lang];

  const goBook = () => navigate('/book');

  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">{t('customer')}</div>
          <h1 className="page-title">{t('homeTitle')}</h1>
          <p className="page-sub">{t('homeSub')}</p>
        </div>
      </div>

      <div className="grid home-grid">
        <section className="home-primary card card-pad" aria-label={t('homeBookSection')}>
          <div className="eyebrow">{t('stepService')}</div>
          <h2 className="home-big">{t('quick')}</h2>
          <p className="muted">{t('homeHow')}</p>
          <button type="button" className="btn btn-primary home-cta" data-tour="home-book" onClick={goBook}>
            {t('homeBookCta')} <ArrowIcon />
          </button>
          <p className="footer-note">{t('briefFare')}: <b>SAR 500</b> {t('perTrip')}. {t('vatPending')}.</p>
        </section>

        <section className="card card-pad home-next" aria-label={t('homeNextTitle')}>
          <div className="between">
            <div className="eyebrow">{t('homeNextTitle')}</div>
            <StatusPill text="DEMO DATA" />
          </div>
          {next ? (
            <>
              <div className="home-trip">
                <div className="home-trip-when">
                  <span className="time-big">{formatTime(next.time, lang)}</span>
                  <span className="route-small">{next.date}</span>
                </div>
                <div className="home-trip-what">
                  <strong className="mono">{next.ref}</strong>
                  <span className="small">{tx(next.dest)}</span>
                  <span className="small muted">{next.passengers} × {t('perPassenger')}</span>
                </div>
              </div>
              <div className="row" style={{ flexWrap: 'wrap', marginTop: 12 }}>
                <StatusPill text={next.payment} />
                <StatusPill text={next.ops} />
              </div>
              <p className="small muted" style={{ marginTop: 12 }}>{t('homeNextNote')}</p>
              <div className="row" style={{ marginTop: 14 }}>
                <button type="button" className="btn btn-outline" onClick={() => navigate('/bookings')}>
                  {t('viewBookings')}
                </button>
                {next.boatId && <span className="small muted">{t('boat')}: {boatName(next.boatId)}</span>}
              </div>
            </>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 10 }}>{t('homeNextNone')}</p>
              <button type="button" className="btn btn-outline" onClick={goBook} style={{ marginTop: 14 }}>
                <Icon name="navBook" />{t('start')}
              </button>
            </>
          )}
        </section>
      </div>

      <div className="grid home-grid" style={{ marginTop: 16 }}>
        <section className="card card-pad home-bookings-card" aria-label={t('navBookings')}>
          <div className="eyebrow">{t('navBookings')}</div>
          <p className="muted">{t('homeBookingsCopy')}</p>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/bookings')} style={{ marginTop: 12 }}>
            {t('navBookings')}
          </button>
        </section>
        <section aria-label={t('contactTitle')}>
          <ContactCard />
        </section>
      </div>
    </>
  );
}
