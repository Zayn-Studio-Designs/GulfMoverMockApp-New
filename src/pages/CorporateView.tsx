import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';

export const CorporateView: React.FC = () => {
  const { language, toggleLanguage } = useLanguage();
  const { demoMode, resetDemoData } = useDemo();

  const t = (key: string) => {
    const translations: Record<string, Record<'en' | 'ar', string>> = {
      'title': { en: 'Corporate & Agent Workspace', ar: 'مساحة عمل الشركات والوكلاء' },
      'subtitle': { en: 'Role-switching preview only. Company and agent records are fictional and access is simulated.', ar: 'معاينة التبديل الأدوار فقط. سجلات الشركات والوكلاء خيالية والوصول محاكى.' },
      'organization': { en: 'Organization', ar: 'المنظمة' },
      'overview': { en: 'Overview', ar: 'نظرة عامة' },
      'bookings': { en: 'Bookings', ar: 'الحجوزات' },
      'passengerList': { en: 'Passengers', ar: 'الركاب' },
      'invoices': { en: 'Invoices', ar: 'الفواتير' },
      'settlements': { en: 'Settlements', ar: 'التسويات' },
      'openBookings': { en: 'Open bookings (demo)', ar: 'الحجوزات المفتوحة (تجريبي)' },
      'creditStatus': { en: 'Credit Status', ar: 'حالة الائتمان' },
      'invoicesDue': { en: 'Invoices due (demo)', ar: 'الفواتير المستحقة (تجريبي)' },
      'assignedOnly': { en: 'Agent view shows assigned transactions only. No real access control exists in this visual prototype.', ar: 'عرض الوكيل يوضح المعاملات المخصصة فقط. لا يوجد تحكم وصول حقيقي في هذا النموذج المرئي.' },
      'demoOnly': { en: 'DEMO DATA', ar: 'بيانات تجريبية' },
      'sample': { en: 'Sample only', ar: 'عينة فقط' },
      'newCorpBooking': { en: 'New Corporate Booking', ar: 'حجز شركة جديد' },
      'poReference': { en: 'PO Reference', ar: 'Reference أمر الشراء' },
      'demoNote': { en: 'Every booking, passenger, availability count and operational record in this prototype is fictional.', ar: 'كل حجز وراكب وعدد التوافر وسجل تشغيلي في هذا النموذج التجريبي هو خيالي.' }
    };

    const translation = translations[key];
    if (translation) {
      return translation[language] || translation['en'] || key;
    }
    return key;
  };

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
        <button
          onClick={toggleLanguage}
          className="language-toggle"
          aria-label={`Toggle language to ${language === 'en' ? 'Arabic' : 'English'}`}
        >
          {language === 'en' ? 'العربية' : 'EN'}
        </button>
      </header>

      <main className="corporate-section">
        <div className="tabs">
          <button className="tab-btn active">{t('overview')}</button>
          <button className="tab-btn">{t('bookings')}</button>
          <button className="tab-btn">{t('passengerList')}</button>
          <button className="tab-btn">{t('invoices')}</button>
          <button className="tab-btn">{t('settlements')}</button>
        </div>

        <div className="tab-content">
          <div className="overview-card">
            <h2>{t('organization')}</h2>
            <p><strong>Gulf Logistics Demo Co.</strong></p>
            <div className="stats">
              <div className="stat">
                <h3>{t('openBookings')}</h3>
                <p>12</p>
              </div>
              <div className="stat">
                <h3>{t('creditStatus')}</h3>
                <p>Good</p>
              </div>
              <div className="stat">
                <h3>{t('invoicesDue')}</h3>
                <p>SAR 2,500</p>
              </div>
            </div>
          </div>

          <div className="tab-content-item">
            <button className="primary-btn">{t('newCorpBooking')}</button>
            <p className="demo-note">{t('demoNote')}</p>
          </div>
        </div>

        <aside className="sidebar">
          <div className="sidebar-section">
            <h3>{t('organization')}</h3>
            <p>Gulf Logistics Demo Co.</p>
            <p>Demo Organization</p>
          </div>

          <div className="sidebar-section">
            <h3>{t('creditStatus')}</h3>
            <p>Terms: Net 30</p>
            <p>Limit: SAR 50,000</p>
            <p>Used: SAR 12,500</p>
          </div>
        </aside>
      </main>

      {demoMode && (
        <footer className="demo-footer">
          <button onClick={resetDemoData} className="demo-btn">
            Reset Demo Data
          </button>
          <span className="demo-note">{t('demoOnly')} - {t('sample')}</span>
        </footer>
      )}
    </div>
  );
};

// Add some basic CSS for the component
const style = document.createElement('style');
style.textContent = `
  .page-container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 20px;
    display: flex;
    gap: 24px;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 30px;
    padding-bottom: 20px;
    border-bottom: 2px solid var(--line);
  }

  .language-toggle {
    background: var(--teal2);
    border: 2px solid var(--teal);
    color: var(--teal);
    width: 40px;
    height: 40px;
    border-radius: var(--radius);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
  }

  .corporate-section {
    flex: 3;
    display: flex;
    flex-direction: column;
  }

  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 24px;
    border-bottom: 1px solid var(--line);
    padding-bottom: 16px;
  }

  .tab-btn {
    background: transparent;
    border: none;
    color: var(--muted);
    padding: 12px 20px;
    cursor: pointer;
    font-weight: 500;
    position: relative;
  }

  .tab-btn.active {
    color: var(--teal);
    font-weight: 600;
  }

  .tab-btn.active::after {
    content: '';
    position: absolute;
    bottom: -16px;
    left: 0;
    width: 100%;
    height: 3px;
    background: var(--teal);
  }

  .tab-btn:hover {
    color: var(--ink);
  }

  .tab-content {
    flex: 1;
  }

  .overview-card {
    background: var(--ice);
    padding: 24px;
    border-radius: var(--radius);
    margin-bottom: 24px;
  }

  .overview-card h2 {
    margin-bottom: 16px;
    color: var(--ink);
  }

  .overview-card p {
    margin-bottom: 20px;
    font-weight: 600;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 16px;
  }

  .stat {
    text-align: center;
  }

  .stat h3 {
    margin-bottom: 8px;
    font-size: 14px;
    color: var(--muted);
    text-transform: uppercase;
  }

  .stat p {
    font-size: 18px;
    font-weight: bold;
    color: var(--ink);
  }

  .tab-content-item {
    padding: 24px;
    background: var(--ice);
    border-radius: var(--radius);
  }

  .primary-btn {
    background: var(--teal);
    color: var(--white);
    border: none;
    padding: 14px 28px;
    border-radius: var(--radius);
    font-weight: 600;
    cursor: pointer;
  }

  .primary-btn:hover {
    background: var(--teal2);
    color: var(--teal);
  }

  .sidebar {
    flex: 1;
    background: var(--ice);
    padding: 24px;
    border-radius: var(--radius);
  }

  .sidebar-section {
    margin-bottom: 24px;
  }

  .sidebar-section h3 {
    margin-bottom: 12px;
    color: var(--ink);
    font-size: 16px;
  }

  .sidebar-section p {
    margin-bottom: 8px;
    color: var(--muted);
    line-height: 1.5;
  }

  .demo-footer {
    margin-top: 40px;
    padding-top: 20px;
    border-top: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 16px;
  }

  .demo-btn {
    background: var(--muted);
    color: var(--white);
    border: none;
    padding: 10px 16px;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .demo-btn:hover {
    background: var(--ink);
  }

  .demo-note {
    font-size: 12px;
    color: var(--muted);
  }

  @media (max-width: 1024px) {
    .page-container {
      flex-direction: column;
    }

    .sidebar {
      order: -1;
      width: 100%;
      margin-bottom: 24px;
    }
  }

  @media (max-width: 600px) {
    .page-container {
      padding: 16px;
    }

    .page-header {
      flex-direction: column;
      gap: 16px;
      text-align: center;
    }

    .tabs {
      flex-wrap: wrap;
    }

    .tab-btn {
      padding: 10px 16px;
      font-size: 14px;
    }
  }
`;

document.head.appendChild(style);

export default CorporateView;