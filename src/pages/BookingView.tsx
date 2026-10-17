import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';

export const BookingView: React.FC = () => {
  const { language, toggleLanguage } = useLanguage();
  const { demoMode, resetDemoData } = useDemo();

  const t = (key: string) => {
    // Simple translation object - in a real app, this would be more comprehensive
    const translations: Record<string, Record<'en' | 'ar', string>> = {
      'title': { en: 'Book a Marine Transfer', ar: 'حجز transfer البحري' },
      'subtitle': { en: 'Choose a service and a sailing. Review the full fare before the payment simulation.', ar: 'اختر خدمة ورحلة. راجع السعر الكامل قبل محاكاة الدفع.' },
      'serviceSelection': { en: 'Service Selection', ar: 'اختيار الخدمة' },
      'passengerTransfer': { en: 'Passenger Transfer', ar: 'نقل ركاب' },
      'materialTransfer': { en: 'Material Transfer', ar: 'نقل مواد' },
      'combinedRequest': { en: 'Combined Request', ar: 'طلب مركب' },
      'charterTrip': { en: 'Dedicated Trip / Charter', ar: 'رحلة مخصصة / مستأجرة' },
      'journey': { en: 'Journey', ar: 'الرحلة' },
      'details': { en: 'Details', ar: 'التفاصيل' },
      'reviewPay': { en: 'Review & Pay', ar: 'راجع وادفع' },
      'result': { en: 'Result', ar: 'النتيجة' },
      'customerBooking': { en: 'CUSTOMER BOOKING', ar: 'حجز العميل' },
      'fareSubtotal': { en: 'Fare Subtotal', ar: 'مجموع الأجرة' },
      'vatTreatment': { en: 'VAT Treatment', ar: 'معاملة الضريبة' },
      'total': { en: 'Total', ar: 'المجموع' },
      'paymentSimulation': { en: 'Payment Simulation', ar: 'محاكاة الدفع' },
      'payRecorded': { en: 'Simulate Payment Recorded', ar: 'محاكاة تسجيل الدفع' },
      'payPending': { en: 'Simulate Payment Pending', ar: 'محاكاة الدفع pending' },
      'payFailed': { en: 'Simulate Payment Failed', ar: 'محاكاة فشل الدفع' },
      'continue': { en: 'Continue', ar: 'متابعة' },
      'back': { en: 'Back', ar: 'رجوع' },
      'findSailings': { en: 'Find Sailings', ar: 'ابحث عن الرحلات' },
      'outboundLeg': { en: 'Outbound Leg', ar: 'الرحلة الذهاب' },
      'returnLeg': { en: 'Return Leg', ar: 'الرحلة العودة' },
      'noReturn': { en: 'No Return Leg Selected', ar: 'لم يتم اختيار رحلة عودة' },
      'quantity': { en: 'Quantity', ar: 'الكمية' },
      'perTrip': { en: 'per passenger · one way', ar: 'لكل راكب · اتجاه واحد' },
      'schedule': { en: 'Schedule', ar: 'الجدول' },
      'localTime': { en: 'Saudi local time', ar: 'الوقت المحلي السعودي' },
      'fareFormula': { en: 'SAR 500 × passengers × selected one-way legs', ar: '500 ريال سعودي × عدد الركاب × الاتجاهات المختارة' },
      'finish': { en: 'Show Booking Result', ar: 'عرض نتيجة الحجز' },
      'bookingResult': { en: 'Booking Result', ar: 'نتيجة الحجز' },
      'paymentStatus': { en: 'Payment Status', ar: 'حالة الدفع' },
      'thresholdStatus': { en: 'Threshold Status', ar: 'حالة العتبة' },
      'opsStatus': { en: 'Operational Status', ar: 'الحالة التشغيلية' },
      'boardingStatus': { en: 'Boarding Status', ar: 'حالة الصعود' },
      'recorded': { en: 'Recorded', ar: 'مسجل' },
      'pending': { en: 'Pending', ar: 'معلق' },
      'met': { en: 'Met', ar: 'مستوفى' },
      'awaiting': { en: 'Awaiting', ar: 'في انتظار' },
      'notStarted': { en: 'Not Started', ar: 'غير begonnen' },
      'collecting': { en: 'Collecting Bookings', ar: 'جمع الحجوزات' },
      'thresholdExplainer': { en: 'The four-ticket threshold is aggregated across all eligible bookings for this sailing, not per customer.', ar: 'عتبة الأربعة تذاكر يتم تجميعها عبر جميع الحجوزات المؤهلة لهذه الرحلة، وليس لكل عميل.' },
      'newBooking': { en: 'Create Another Demo Booking', ar: 'إنشاء حجز تجريبي آخر' },
      'viewBookings': { en: 'View My Bookings', ar: 'عرض حجوزاتي' }
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

      <main className="booking-form">
        <section className="service-selection">
          <h2>{t('serviceSelection')}</h2>
          <div className="service-options">
            <button className="service-option">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 5a2 2 0 0 1 2-2h3l2 4h2l2-4h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5z"/>
              </svg>
              <span>{t('passengerTransfer')}</span>
            </button>
            <button className="service-option">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 3h18v2H3V3zm0 8h18v2H3v-2zm0 8h18v2H3v-2z"/>
              </svg>
              <span>{t('materialTransfer')}</span>
            </button>
            <button className="service-option">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 4v16m8-8H4"/>
              </svg>
              <span>{t('combinedRequest')}</span>
            </button>
            <button className="service-option">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 3h18v2H3V3zm0 16h18v2H3v-2z"/>
              </svg>
              <span>{t('charterTrip')}</span>
            </button>
          </div>
        </section>

        <section className="journey-selection">
          <h2>{t('journey')}</h2>
          <div className="form-group">
            <label>{t('outboundLeg')}</label>
            <select>
              <option value="07:00">07:00</option>
              <option value="09:30">09:30</option>
              <option value="13:00">13:00</option>
            </select>
          </div>

          <div className="form-group">
            <label>{t('returnLeg')}</label>
            <select>
              <option value="">-- {t('noReturn')} --</option>
              <option value="07:00">07:00</option>
              <option value="09:30">09:30</option>
              <option value="13:00">13:00</option>
            </select>
          </div>
        </section>

        <section className="passenger-details">
          <h2>{t('details')}</h2>
          <div className="form-group">
            <label>Full Name</label>
            <input type="text" placeholder="Enter full name" />
          </div>
          <div className="form-group">
            <label>Email</label>
            <input type="email" placeholder="Enter email" />
          </div>
          <div className="form-group">
            <label>Phone Number</label>
            <input type="tel" placeholder="Enter phone number" />
          </div>
        </section>

        <section className="fare-review">
          <h2>{t('reviewPay')}</h2>
          <div className="fare-breakdown">
            <div className="fare-item">
              <span>{t('fareSubtotal')}</span>
              <span>SAR 500</span>
            </div>
            <div className="fare-item">
              <span>{t('vatTreatment')}</span>
              <span>Pending ATCO confirmation</span>
            </div>
            <div className="fare-item total">
              <span>{t('total')}</span>
              <span>SAR 500</span>
            </div>
          </div>

          <div className="policy-section">
            <p>This is a demo - no real payment will be processed.</p>
            <p>Booking does not authorize port entry or vessel departure.</p>
          </div>

          <button className="primary-btn" onClick={() => alert('Booking simulated!')}>
            {t('finish')}
          </button>
        </section>
      </main>

      {demoMode && (
        <footer className="demo-footer">
          <button onClick={resetDemoData} className="demo-btn">
            Reset Demo Data
          </button>
          <span className="demo-note">DEMO DATA - {t('demoNote')}</span>
        </footer>
      )}
    </div>
  );
};

// Add some basic CSS for the component
const style = document.createElement('style');
style.textContent = `
  .page-container {
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
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

  .service-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 16px;
    margin: 20px 0;
  }

  .service-option {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px;
    border: 2px solid var(--line);
    border-radius: var(--radius);
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .service-option:hover {
    background: var(--teal2);
    border-color: var(--teal);
  }

  .service-option svg {
    width: 48px;
    height: 48px;
    margin-bottom: 12px;
  }

  .form-group {
    margin-bottom: 20px;
  }

  .form-group label {
    display: block;
    margin-bottom: 8px;
    font-weight: 600;
  }

  .form-group input,
  .form-group select {
    width: 100%;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font: inherit;
  }

  .fare-breakdown {
    display: grid;
    gap: 12px;
    margin: 20px 0;
  }

  .fare-item {
    display: flex;
    justify-content: space-between;
    padding: 12px;
    background: var(--ice);
    border-radius: var(--radius);
  }

  .fare-item.total {
    background: var(--teal2);
    border: 2px solid var(--teal);
    font-weight: bold;
  }

  .policy-section {
    background: var(--ice);
    padding: 20px;
    border-radius: var(--radius);
    margin: 20px 0;
    font-size: 14px;
    color: var(--muted);
  }

  .primary-btn {
    background: var(--teal);
    color: var(--white);
    border: none;
    padding: 14px 28px;
    border-radius: var(--radius);
    font-weight: 600;
    cursor: pointer;
    width: 100%;
    max-width: 300px;
  }

  .primary-btn:hover {
    background: var(--teal2);
    color: var(--teal);
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

  @media (max-width: 600px) {
    .page-container {
      padding: 16px;
    }

    .page-header {
      flex-direction: column;
      gap: 16px;
      text-align: center;
    }

    .demo-footer {
      flex-direction: column;
      align-items: stretch;
    }
  }
`;

document.head.appendChild(style);

export default BookingView;