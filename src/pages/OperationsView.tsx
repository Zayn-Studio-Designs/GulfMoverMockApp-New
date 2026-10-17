import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';

export const OperationsView: React.FC = () => {
  const { language, toggleLanguage } = useLanguage();
  const { demoMode, resetDemoData } = useDemo();

  const t = (key: string) => {
    const translations: Record<string, Record<'en' | 'ar', string>> = {
      'title': { en: 'Operations Overview', ar: 'نظرة عامة على العمليات' },
      'subtitle': { en: 'Sample operations console. All counts, capacity and statuses are fictional demo data.', ar: 'وحدة تحكم عمليات عينة. جميع العدد وال السعات والحالات هي بيانات تجريبية خيالية.' },
      'sailingsToday': { en: 'Sailings Today', ar: 'الرحلات اليوم' },
      'awaitingMinimum': { en: 'Awaiting Minimum', ar: 'في انتظار العتبة' },
      'awaitingOps': { en: 'Awaiting Operational Approval', ar: 'في انتظار الموافقة التشغيلية' },
      'materialsPending': { en: 'Materials Pending Review', ar: 'المواد في انتظار المراجعة' },
      'filter': { en: 'Filter', ar: 'فلتر' },
      'status': { en: 'Status', ar: 'الحالة' },
      'direction': { en: 'Direction', ar: 'الاتجاه' },
      'allStatuses': { en: 'All Statuses', ar: 'جميع الحالات' },
      'allDirections': { en: 'All Directions', ar: 'جميع الاتجاهات' },
      'time': { en: 'Time', ar: 'الوقت' },
      'route': { en: 'Route', ar: 'المسار' },
      'tickets': { en: 'Eligible Tickets', ar: 'التذاكر المؤهلة' },
      'threshold': { en: 'Threshold', ar: 'العتبة' },
      'readiness': { en: 'Readiness', ar: 'الجاهزية' },
      'manifest': { en: 'Manifest', ar: 'بيان الشحن' },
      'nextAction': { en: 'Next Action', ar: 'الإجراء التالي' },
      'demoOnly': { en: 'DEMO DATA', ar: 'بيانات تجريبية' },
      'sample': { en: 'Sample only', ar: 'عينة فقط' },
      'sailingTable': { en: 'Sailing Schedule', ar: 'جدول الرحلات' },
      'opsPending': { en: 'Awaiting Approval', ar: 'في انتظار الموافقة' },
      'opsSuspended': { en: 'Suspended (demo)', ar: 'معلق (تجريبي)' },
      'openDetail': { en: 'Open Details', ar: 'فتح التفاصيل' },
      'review': { en: 'Review', ar: 'مراجعة' },
      'openManifest': { en: 'Open Manifest', ar: 'فتح بيان الشحن' },
      'suspend': { en: 'Suspend Sailing', ar: 'تعليق الرحلة' },
      'opsGate': { en: 'Payment and threshold are not operational clearance. Only an authorized recorded ATCO decision can change readiness.', ar: 'الدفع والعتبة ليسان تصريحًا تشغيليًا. فقط قرار ATCO مسجل ومخول يمكن تغيير الجاهزية.' },
      'sailingDetail': { en: 'Sailing Detail', ar: 'تفاصيل الرحلة' },
      'audit': { en: 'Demo Audit Trail', ar: 'مسار تدقيق تجريبي' },
      'attention': { en: 'Attention Queues', ar: 'queues انتباه' },
      'materialQueue': { en: 'Materials Review', ar: 'مراجعة المواد' },
      'financeQueue': { en: 'Finance Exceptions (demo)', ar: 'استثناءات مالية (تجريبي)' },
      'reasonSuspend': { en: 'Record a demo suspension reason. This does not change a real sailing.', ar: 'سجل سبب التعليق التجريبي. هذا لا يغير رحلة حقيقية.' },
      'manualLookup': { en: 'Manual Booking-Reference Lookup', ar: 'بحث يدوي anhand reference الحجز' },
      'lookup': { en: 'Look up', ar: 'ابحث' },
      'override': { en: 'Override', ar: 'Override' },
      'overrideReason': { en: 'A reason is required for the demo override.', ar: 'يتطلب سبب للoverride التجريبي.' },
      'recentScans': { en: 'Recent Demo Scans', ar: 'المسحات التجريبية الأخيرة' },
      'notBoarded': { en: 'Not Boarded', ar: 'لم يصعد' },
      'alreadyBoarded': { en: 'Already Boarded', ar: 'صعد بالفعل' },
      'thresholdExplainer': { en: 'The four-ticket threshold is aggregated across all eligible bookings for this sailing, not per customer.', ar: 'عتبة الأربعة تذاكر يتم تجميعها عبر جميع الحجوزات المؤهلة لهذه الرحلة، وليس لكل عميل.' }
    };

    const translation = translations[key];
    if (translation) {
      return translation[language] || translation['en'] || key;
    }
    return key;
  };

  // Mock sailing data
  const mockSailings = [
    {
      id: 'SAIL-001',
      time: '07:00',
      route: 'Ras Tanura to Bahrain (Demo)',
      tickets: '2/4',
      threshold: 'Not Met',
      readiness: 'Awaiting Approval',
      manifest: 'Not Complete'
    },
    {
      id: 'SAIL-002',
      time: '09:30',
      route: 'Ras Tanura to Kuwait (Demo)',
      tickets: '4/4',
      threshold: 'Met',
      readiness: 'Approved',
      manifest: 'Complete'
    },
    {
      id: 'SAIL-003',
      time: '13:00',
      route: 'Ras Tanura to Qatar (Demo)',
      tickets: '1/4',
      threshold: 'Not Met',
      readiness: 'Pending',
      manifest: 'Not Complete'
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

      <main className="operations-section">
        <div className="stats-bar">
          <div className="stat-item">
            <h3>{t('sailingsToday')}</h3>
            <p>{mockSailings.length}</p>
          </div>
          <div className="stat-item">
            <h3>{t('awaitingMinimum')}</h3>
            <p>{mockSailings.filter(s => s.threshold === 'Not Met').length}</p>
          </div>
          <div className="stat-item">
            <h3>{t('awaitingOps')}</h3>
            <p>{mockSailings.filter(s => s.readiness === 'Awaiting Approval').length}</p>
          </div>
          <div className="stat-item">
            <h3>{t('materialsPending')}</h3>
            <p>3</p>
          </div>
        </div>

        <div className="filters">
          <div className="filter-group">
            <label>{t('status')}</label>
            <select>
              <option value="all">{t('allStatuses')}</option>
              <option value="pending">{t('awaitingMinimum')}</option>
              <option value="approved">{t('awaitingOps')}</option>
            </select>
          </div>
          <div className="filter-group">
            <label>{t('direction')}</label>
            <select>
              <option value="all">{t('allDirections')}</option>
              <option value="outbound">{t('outboundLeg')}</option>
              <option value="return">{t('returnLeg')}</option>
            </select>
          </div>
        </div>

        <div className="sailing-table-container">
          <h2>{t('sailingTable')}</h2>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>{t('time')}</th>
                  <th>{t('route')}</th>
                  <th>{t('tickets')}</th>
                  <th>{t('threshold')}</th>
                  <th>{t('readiness')}</th>
                  <th>{t('manifest')}</th>
                  <th>{t('nextAction')}</th>
                </tr>
              </thead>
              <tbody>
                {mockSailings.map((sailing) => (
                  <tr key={sailing.id}>
                    <td>{sailing.time}</td>
                    <td>{sailing.route}</td>
                    <td>
                      <div className="threshold-indicator">
                        <div className={`threshold-bar ${sailing.threshold.toLowerCase().replace(/\s/g, '')}`}>
                          <div className="threshold-fill" style={{ width: sailing.tickets.includes('/') ? (parseInt(sailing.tickets.split('/')[0]) / parseInt(sailing.tickets.split('/')[1]) * 100) : 0 }}></div>
                        </div>
                        <span>{sailing.tickets}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${sailing.threshold.toLowerCase().replace(/\s/g, '')}`}>
                        {sailing.threshold}
                      </span>
                    </td>
                    <td>
                      <span className={`status-badge ${sailing.readiness.toLowerCase().replace(/\s/g, '')}`}>
                        {sailing.readiness}
                      </span>
                    </td>
                    <td>
                      <span className={`status-badge ${sailing.manifest.toLowerCase().replace(/\s/g, '')}`}>
                        {sailing.manifest}
                      </span>
                    </td>
                    <td className="actions-cell">
                      <button className="action-btn">{t('openDetail')}</button>
                      <button className="action-btn">{t('review')}</button>
                      {sailing.manifest === 'Complete' && (
                        <button className="action-btn">{t('openManifest')}</button>
                      )}
                      {sailing.readiness === 'Approved' && (
                        <button className="action-btn" onClick={() => alert('Suspension simulated')}>
                          {t('suspend')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="attention-queues">
          <h2>{t('attention')}</h2>
          <div className="queues">
            <div className="queue-item">
              <h3>{t('materialQueue')}</h3>
              <p>5</p>
            </div>
            <div className="queue-item">
              <h3>{t('financeQueue')}</h3>
              <p>2</p>
            </div>
          </div>
        </div>

        <div className="ops-note">
          <p>{t('opsGate')}</p>
        </div>
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

  .operations-section {
  }

  .stats-bar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-item {
    text-align: center;
    background: var(--ice);
    padding: 20px;
    border-radius: var(--radius);
  }

  .stat-item h3 {
    margin-bottom: 8px;
    font-size: 14px;
    color: var(--muted);
    text-transform: uppercase;
  }

  .stat-item p {
    font-size: 24px;
    font-weight: bold;
    color: var(--ink);
  }

  .filters {
    display: flex;
    gap: 16px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }

  .filter-group {
    display: flex;
    flex-direction: column;
    min-width: 180px;
  }

  .filter-group label {
    margin-bottom: 8px;
    font-weight: 600;
  }

  .filter-group select {
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font: inherit;
    background: var(--white);
  }

  .sailing-table-container {
    margin-bottom: 24px;
  }

  .sailing-table-container h2 {
    margin-bottom: 16px;
  }

  .table-wrapper {
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 800px;
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

  .threshold-indicator {
    display: flex;
    align-items: center;
    margin: 4px 0;
  }

  .threshold-bar {
    width: 80px;
    height: 8px;
    background: var(--line);
    border-radius: 4px;
    overflow: hidden;
    margin-right: 8px;
  }

  .threshold-fill {
    height: 100%;
    background: var(--teal);
    transition: width 0.3s ease;
  }

  .threshold-bar.thresholdnotmet .threshold-fill { background: var(--red); }
  .threshold-bar.thresholdmet .threshold-fill { background: var(--green); }

  .status-badge {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 500;
  }

  .status-badge.thresholdnotmet { background: var(--redbg); color: var(--red); }
  .status-badge.thresholdmet { background: var(--greenbg); color: var(--green); }
  .status-badge.approved { background: var(--teal2); color: var(--teal); }
  .status-badge.pending { background: var(--bluebg); color: var(--blue); }

  .actions-cell {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .action-btn {
    background: transparent;
    border: 1px solid var(--line);
    color: var(--ink);
    padding: 8px 12px;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
  }

  .action-btn:hover {
    background: var(--teal2);
    border-color: var(--teal);
    color: var(--teal);
  }

  .attention-queues {
    margin-top: 24px;
  }

  .attention-queues h2 {
    margin-bottom: 16px;
  }

  .queues {
    display: flex;
    gap: 24px;
  }

  .queue-item {
    text-align: center;
    background: var(--ice);
    padding: 16px;
    border-radius: var(--radius);
    flex: 1;
  }

  .queue-item h3 {
    margin-bottom: 8px;
    font-size: 14px;
    color: var(--ink);
  }

  .queue-item p {
    font-size: 18px;
    font-weight: bold;
    color: var(--teal);
  }

  .ops-note {
    background: var(--ice);
    padding: 20px;
    border-radius: var(--radius);
    margin-top: 24px;
    font-size: 14px;
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
      padding: 16px;
    }

    .stats-bar {
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    }

    .filters {
      flex-direction: column;
    }

    .filter-group {
      width: 100%;
    }

    .sailing-table-container h2 {
      font-size: 18px;
    }

    th, td {
      padding: 12px;
      font-size: 14px;
    }
  }

  @media (max-width: 600px) {
    .page-container {
      padding: 12px;
    }

    .page-header {
      flex-direction: column;
      gap: 12px;
      text-align: center;
    }

    .stats-bar {
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .sailing-table-container {
      margin-top: 20px;
    }

    table {
      min-width: 100%;
    }

    th, td {
      padding: 10px;
      font-size: 13px;
    }

    .actions-cell {
      flex-direction: column;
      align-items: stretch;
    }

    .action-btn {
      width: 100%;
      margin-bottom: 8px;
    }
  }
`;

document.head.appendChild(style);

export default OperationsView;