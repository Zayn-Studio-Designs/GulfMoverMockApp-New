import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';

export const BoardingView: React.FC = () => {
  const { language, toggleLanguage } = useLanguage();
  const { demoMode, resetDemoData } = useDemo();

  const t = (key: string) => {
    const translations: Record<string, Record<'en' | 'ar', string>> = {
      'title': { en: 'Boarding Desk', ar: 'مكتب الصعود' },
      'subtitle': { en: 'Tablet-friendly scan simulation. QR/ticket records are fictional and do not authorize boarding or sailing.', ar: 'محاكاة فحص مناسبة للأجهزة اللوحية. سجلات QR/التذاكر خيالية ولا تفوض الصعود أو الإبحار.' },
      'selectedSailing': { en: 'Selected Sailing', ar: 'الرحلة المختارة' },
      'boardingCounter': { en: 'Boarded / Eligible Tickets (demo)', ar: 'صعد / تذاكر مؤهلة (تجريبي)' },
      'simulateScan': { en: 'Simulate Valid QR Scan', ar: 'محاكاة فحص QR صالح' },
      'repeatScan': { en: 'Scan the Same Ticket Again', ar: 'امسح التذكرة نفسها مرة أخرى' },
      'scanTitle': { en: 'Scan Result', ar: 'نتيجة الفحص' },
      'scanValid': { en: 'Ticket accepted in demo; boarding status recorded locally.', ar: 'تم قبول التذكرة في العرض التجريبي؛ تم تسجيل حالة الصعود محليًا.' },
      'scanDuplicate': { en: 'Already scanned — exception required. No second boarding has been recorded.', ar: 'تم المسح بالفعل — مطلوب استثناء. لم يتم تسجيل صعود ثانٍ.' },
      'manualLookup': { en: 'Manual Booking-Reference Lookup', ar: 'بحث يدوي anhand reference الحجز' },
      'lookup': { en: 'Look up', ar: 'ابحث' },
      'override': { en: 'Override', ar: 'Override' },
      'overrideReason': { en: 'A reason is required for the demo override.', ar: 'يتطلب سبب للoverride التجريبي.' },
      'reasonPlaceholder': { en: 'Enter a short reason...', ar: 'أدخل سببًا قصيرًا...' },
      'recentScans': { en: 'Recent Demo Scans', ar: 'المسحات التجريبية الأخيرة' },
      'notBoarded': { en: 'Not Boarded', ar: 'لم يصعد' },
      'alreadyBoarded': { en: 'Already Boarded', ar: 'صعد بالفعل' },
      'time': { en: 'Time', ar: 'الوقت' },
      'destination': { en: 'Destination', ar: 'الوجهة' },
      'expected': { en: 'Expected', ar: 'متوقع' },
      'boarded': { en: 'Boarded', ar: 'صعد' },
      'notBoarded': { en: 'Not Boarded', ar: 'لم يصعد' },
      'demoOnly': { en: 'DEMO DATA', ar: 'بيانات تجريبية' },
      'sample': { en: 'Sample only', ar: 'عينة فقط' },
      'demoNote': { en: 'Every booking, passenger, availability count and operational record in this prototype is fictional.', ar: 'كل حجز وراكب وعدد التوافر وسجل تشغيلي في هذا النموذج التجريبي هو خيالي.' }
    };

    const translation = translations[key];
    if (translation) {
      return translation[language] || translation['en'] || key;
    }
    return key;
  };

  // Mock scanning state
  const [selectedSailing, setSelectedSailing] = React.useState({
    time: '09:30',
    destination: 'Ras Tanura to Bahrain (Demo)'
  });

  const [boardingCount, setBoardingCount] = React.useState({ boarded: 2, eligible: 4 });
  const [recentScans, setRecentScans] = React.useState([
    { time: '09:15', reference: 'GM-DEMO-001', status: 'Boarded' },
    { time: '09:10', reference: 'GM-DEMO-002', status: 'Not Boarded' }
  ]);

  const handleScan = () => {
    // Simulate a valid scan
    setRecentScans(prev => [
      {
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        reference: `GM-DEMO-${Math.floor(Math.random() * 1000)}`,
        status: 'Boarded'
      },
      ...prev.slice(0, 4) // Keep only last 5 scans
    ]);
    setBoardingCount(prev => ({
      boarded: Math.min(prev.boarded + 1, prev.eligible),
      eligible: prev.eligible
    }));
  };

  const handleRepeatScan = () => {
    // Simulate a duplicate scan
    setRecentScans(prev => [
      {
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        reference: 'DUPLICATE',
        status: 'Duplicate'
      },
      ...prev.slice(0, 4)
    ]);
    alert('Already scanned — exception required. No second boarding has been recorded.');
  };

  const handleManualLookup = () => {
    // Simulate manual lookup
    setRecentScans(prev => [
      {
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        reference: 'MANUAL-LOOKUP',
        status: 'Boarded'
      },
      ...prev.slice(0, 4)
    ]);
    setBoardingCount(prev => ({
      boarded: Math.min(prev.boarded + 1, prev.eligible),
      eligible: prev.eligible
    }));
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

      <main className="boarding-section">
        <div className="sailing-info">
          <h2>{t('selectedSailing')}</h2>
          <div className="sailing-details">
            <div className="detail-item">
              <span>{t('time')}</span>
              <span>{selectedSailing.time}</span>
            </div>
            <div className="detail-item">
              <span>{t('destination')}</span>
              <span>{selectedSailing.destination}</span>
            </div>
          </div>

          <div className="boarding-counter">
            <h3>{t('boardingCounter')}</h3>
            <div className="counter-display">
              <span>{boardingCount.boarded}</span> / <span>{boardingCount.eligible}</span>
            </div>
          </div>
        </div>

        <div className="scan-controls">
          <button className="primary-btn" onClick={handleScan}>
            {t('simulateScan')}
          </button>
          <button className="secondary-btn" onClick={handleRepeatScan}>
            {t('repeatScan')}
          </button>
        </div>

        <div className="manual-lookup">
          <h3>{t('manualLookup')}</h3>
          <div className="input-group">
            <input
              type="text"
              placeholder={t('lookup')}
              className="lookup-input"
            />
            <button className="primary-btn" onClick={handleManualLookup}>
              {t('override')}
            </button>
          </div>
          <p className="hint">{t('overrideReason')}</p>
          <input
            type="text"
            placeholder={t('reasonPlaceholder')}
            className="reason-input"
          />
        </div>

        <div className="recent-scans">
          <h3>{t('recentScans')}</h3>
          <div className="scans-list">
            {recentScans.map((scan, index) => (
              <div key={index} className={`scan-item ${scan.status.toLowerCase()}`}>
                <span className="scan-time">{scan.time}</span>
                <span className="scan-ref">{scan.reference}</span>
                <span className="scan-status">{scan.status}</span>
              </div>
            ))}
          </div>
        </div>
      </main>

      {demoMode && (
        <footer className="demo-footer">
          <button onClick={resetDemoData} className="demo-btn">
            Reset Demo Data
          </button>
          <span className="demo-note">{t('demoOnly')} - {t('sample')}</span>
          <span className="demo-note">{t('demoNote')}</span>
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

  .boarding-section {
  }

  .sailing-info {
    background: var(--ice);
    padding: 24px;
    border-radius: var(--radius);
    margin-bottom: 24px;
  }

  .sailing-info h2 {
    margin-bottom: 16px;
  }

  .sailing-details {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 20px;
  }

  .detail-item {
    display: flex;
    justify-content: space-between;
  }

  .detail-item span:first-child {
    color: var(--muted);
    font-weight: 500;
  }

  .detail-item span:last-child {
    font-weight: 600;
  }

  .boarding-counter {
    text-align: center;
  }

  .boarding-counter h3 {
    margin-bottom: 12px;
  }

  .counter-display {
    font-size: 36px;
    font-weight: bold;
    color: var(--teal);
    letter-spacing: -1px;
  }

  .scan-controls {
    display: flex;
    gap: 16px;
    margin-bottom: 24px;
    flex-wrap: wrap;
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

  .secondary-btn {
    background: var(--ice);
    border: 2px solid var(--line);
    color: var(--ink);
    padding: 14px 28px;
    border-radius: var(--radius);
    font-weight: 600;
    cursor: pointer;
  }

  .secondary-btn:hover {
    background: var(--teal2);
    border-color: var(--teal);
    color: var(--teal);
  }

  .manual-lookup {
    background: var(--ice);
    padding: 24px;
    border-radius: var(--radius);
    margin-bottom: 24px;
  }

  .manual-lookup h3 {
    margin-bottom: 16px;
  }

  .input-group {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .lookup-input,
  .reason-input {
    flex: 1;
    min-width: 200px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font: inherit;
  }

  .lookup-input:focus,
  .reason-input:focus {
    outline: 2px solid var(--teal);
  }

  .hint {
    font-size: 14px;
    color: var(--muted);
    margin-bottom: 12px;
  }

  .recent-scans {
    margin-top: 24px;
  }

  .recent-scans h3 {
    margin-bottom: 16px;
  }

  .scans-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .scan-item {
    display: flex;
    justify-content: space-between;
    padding: 12px;
    background: var(--white);
    border-radius: var(--radius);
    border: 1px solid var(--line);
  }

  .scan-item.notboarded {
    background: var(--redbg);
    border-color: var(--red);
  }

  .scan-item.alreadyboarded {
    background: var(--greenbg);
    border-color: var(--green);
  }

  .scan-item.duplicate {
    background: var(--bluebg);
    border-color: var(--blue);
  }

  .scan-time {
    font-weight: 500;
    min-width: 80px;
  }

  .scan-ref {
    flex: 1;
    text-align: center;
    font-family: 'Courier New', monospace;
  }

  .scan-status {
    font-weight: 600;
    text-transform: capitalize;
    min-width: 100px;
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

    .scan-controls {
      flex-direction: column;
      align-items: stretch;
    }

    .input-group {
      flex-direction: column;
    }

    .lookup-input,
    .reason-input {
      width: 100%;
    }

    .scans-list {
      gap: 6px;
    }

    .scan-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
    }

    .scan-time {
      font-weight: 600;
    }

    .scan-ref {
      text-align: left;
    }
  }
`;

document.head.appendChild(style);

export default BoardingView;