import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';

export const MyBookingsView: React.FC = () => {
  const { language, toggleLanguage } = useLanguage();
  const { demoMode, resetDemoData } = useDemo();

  const t = (key: string) => {
    const translations: Record<string, Record<'en' | 'ar', string>> = {
      'title': { en: 'My Bookings', ar: 'حجوزاتي' },
      'subtitle': { en: 'Your fictional booking records and their separate status dimensions.', ar: 'سجلات الحجز الخيالية الخاصة بك وأبعاد الحالة المنفصلة.' },
      'search': { en: 'Search', ar: 'بحث' },
      'searchPlaceholder': { en: 'Search booking reference...', ar: 'ابحث عن reference الحجز...' },
      'allStatuses': { en: 'All Statuses', ar: 'جميع الحالات' },
      'noBookings': { en: 'No matching bookings. Try a different search.', ar: 'لا توجد حجوزات متطابقة. جرب بحثًا مختلفًا.' },
      'bookingReference': { en: 'Booking Reference', ar: 'Reference الحجز' },
      'date': { en: 'Date', ar: 'التاريخ' },
      'leg': { en: 'Leg', ar: 'القطاع' },
      'status': { en: 'Status', ar: 'الحالة' },
      'amount': { en: 'Amount', ar: 'المبلغ' },
      'actions': { en: 'Actions', ar: 'الإجراءات' },
      'viewDetails': { en: 'View Details', ar: 'عرض التفاصيل' },
      'viewTicket': { en: 'View Ticket', ar: 'عرض التذكرة' },
      'requestAmend': { en: 'Request Amendment / Reschedule', ar: 'طلب تعديل / إعادة جدولة' },
      'requestRefund': { en: 'Request Refund', ar: 'طلب استرداد' },
      'requestReceived': { en: 'Demo request recorded locally; no transaction has been sent.', ar: 'تم تسجيل الطلب تجريبيًا محليًا؛ لم يتم إرسال أي معاملة.' },
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
      'demoOnly': { en: 'DEMO DATA', ar: 'بيانات تجريبية' },
      'sample': { en: 'Sample only', ar: 'عينة فقط' }
    };

    const translation = translations[key];
    if (translation) {
      return translation[language] || translation['en'] || key;
    }
    return key;
  };

  // Mock booking data
  const mockBookings = [
    {
      id: 'GM-DEMO-001',
      date: '2026-10-20',
      leg: 'Outbound',
      status: 'Confirmed',
      amount: 'SAR 1,000',
      paymentStatus: 'Recorded',
      thresholdStatus: 'Met',
      opsStatus: 'Approved',
      boardingStatus: 'Not Boarded'
    },
    {
      id: 'GM-DEMO-002',
      date: '2026-10-21',
      leg: 'Return',
      status: 'Pending',
      amount: 'SAR 500',
      paymentStatus: 'Pending',
      thresholdStatus: 'Collecting',
      opsStatus: 'Awaiting',
      boardingStatus: 'Not Boarded'
    }
  ];

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

      <main className="bookings-section">
        <div className="search-section">
          <input
            type="text"
            placeholder={t('searchPlaceholder')}
            className="search-input"
          />
          <button className="filter-btn">{t('allStatuses')}</button>
        </div>

        {mockBookings.length > 0 ? (
          <div className="bookings-table">
            <table>
              <thead>
                <tr>
                  <th>{t('bookingReference')}</th>
                  <th>{t('date')}</th>
                  <th>{t('leg')}</th>
                  <th>{t('status')}</th>
                  <th>{t('amount')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {mockBookings.map((booking) => (
                  <tr key={booking.id}>
                    <td>{booking.id}</td>
                    <td>{booking.date}</td>
                    <td>{booking.leg}</td>
                    <td>
                      <span className={`status-badge ${booking.status.toLowerCase()}`}>
                        {booking.status}
                      </span>
                    </td>
                    <td>{booking.amount}</td>
                    <td className="actions-cell">
                      <button className="action-btn">{t('viewDetails')}</button>
                      <button className="action-btn">{t('viewTicket')}</button>
                      <button className="action-btn">{t('requestAmend')}</button>
                      <button className="action-btn">{t('requestRefund')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="no-bookings">{t('noBookings')}</p>
        )}
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
    max-width: 1000px;
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

  .search-section {
    display: flex;
    gap: 12px;
    margin-bottom: 24px;
  }

  .search-input {
    flex: 1;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font: inherit;
  }

  .filter-btn {
    background: var(--teal2);
    border: 2px solid var(--teal);
    color: var(--teal);
    padding: 12px 20px;
    border-radius: var(--radius);
    cursor: pointer;
    font-weight: 600;
  }

  .filter-btn:hover {
    background: var(--teal);
    color: var(--white);
  }

  .bookings-table {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th, td {
    padding: 16px;
    text-align: left;
    border-bottom: 1px solid var(--line);
  }

  th {
    background: var(--ice);
    font-weight: 600;
    text-transform: uppercase;
    font-size: 14px;
  }

  tr:hover {
    background: rgba(0, 0, 0, 0.02);
  }

  .status-badge {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 500;
  }

  .status-badge.confirmed { background: var(--greenbg); color: var(--green); }
  .status-badge.pending { background: var(--redbg); color: var(--red); }
  .status-badge.met { background: var(--greenbg); color: var(--green); }
  .status-badge.awaiting { background: var(--bluebg); color: var(--blue); }

  .actions-cell {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .action-btn {
    background: transparent;
    border: 1px solid var(--line);
    color: var(--ink);
    padding: 8px 16px;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 14px;
  }

  .action-btn:hover {
    background: var(--teal2);
    border-color: var(--teal);
    color: var(--teal);
  }

  .no-bookings {
    text-align: center;
    padding: 40px;
    color: var(--muted);
    font-style: italic;
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

  @media (max-width: 768px) {
    .page-container {
      padding: 16px;
    }

    .page-header {
      flex-direction: column;
      gap: 16px;
      text-align: center;
    }

    .search-section {
      flex-direction: column;
    }

    .actions-cell {
      flex-direction: column;
      align-items: stretch;
    }

    .demo-footer {
      flex-direction: column;
      align-items: stretch;
    }
  }
`;

document.head.appendChild(style);

export default MyBookingsView;