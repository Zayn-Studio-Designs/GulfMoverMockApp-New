import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useDemo } from '../context/DemoContext';

export const MaterialsView: React.FC = () => {
  const { language, toggleLanguage } = useLanguage();
  const { demoMode, resetDemoData } = useDemo();

  const t = (key: string) => {
    const translations: Record<string, Record<'en' | 'ar', string>> = {
      'title': { en: 'Materials Review', ar: 'مراجعة المواد' },
      'subtitle': { en: 'Requests are pending until an authorized operations reviewer decides. Submission is not acceptance.', ar: 'الطلبات معلقة حتى يقررها مراجع العمليات المخول. التقديم ليس قبولًا.' },
      'request': { en: 'Request', ar: 'طلب' },
      'description': { en: 'Description', ar: 'الوصف' },
      'quantity': { en: 'Quantity', ar: 'الكمية' },
      'weight': { en: 'Weight (demo)', ar: 'الوزن (تجريبي)' },
      'dimensions': { en: 'Dimensions (demo)', ar: 'الأبعاد (تجريبي)' },
      'sender': { en: 'Sender (demo)', ar: 'المرسل (تجريبي)' },
      'receiver': { en: 'Receiver (demo)', ar: 'المستقبل (تجريبي)' },
      'pendingReview': { en: 'Pending Review', ar: 'معلق للمراجعة' },
      'clarification': { en: 'Clarification Required', ar: 'يتطلب توضيحًا' },
      'approvedConditions': { en: 'Approved with Conditions (demo)', ar: 'موافق عليه بشروط (تجريبي)' },
      'rejected': { en: 'Rejected (demo)', ar: 'مرفوض (تجريبي)' },
      'delivered': { en: 'Delivered (demo)', ar: 'تم التسليم (تجريبي)' },
      'approveConditions': { en: 'Approve with Conditions', ar: 'الموافقة بشروط' },
      'requestClarification': { en: 'Request Clarification', ar: 'طلب توضيح' },
      'reject': { en: 'Reject Request', ar: 'رفض الطلب' },
      'reasonForDecision': { en: 'Decision Reason / Conditions', ar: 'سبب القرار / الشروط' },
      'decisionSaved': { en: 'Demo decision saved locally.', ar: 'تم حفظ القرار التجريبي محليًا.' },
      'noResults': { en: 'No records match these filters.', ar: 'لا توجد سجلات تطابق هذه الفلاتر.' },
      'filter': { en: 'Filter', ar: 'فلتر' },
      'clear': { en: 'Clear', ar: 'مسح' },
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

  // Mock materials data
  const [materials, setMaterials] = React.useState([
    {
      id: 'MAT-001',
      description: 'Construction steel beams',
      quantity: '10 tons',
      weight: '10,000 kg',
      dimensions: '6m x 0.5m x 0.3m',
      sender: 'Al-Rayan Construction Co.',
      receiver: 'Ras Tanura Port Facility',
      status: 'pendingReview'
    },
    {
      id: 'MAT-002',
      description: 'Food supplies - dates and water',
      quantity: '500 kg',
      weight: '500 kg',
      dimensions: 'Various packages',
      sender: 'Gulf Food Distributors',
      receiver: 'Vessel GM-001',
      status: 'approvedConditions'
    },
    {
      id: 'MAT-003',
      description: 'Chemical containers (unlabeled)',
      quantity: '5 containers',
      weight: '2,000 kg',
      dimensions: '1.2m diameter x 2m height',
      sender: 'Unknown Supplier',
      receiver: 'Ras Tanura Industrial Zone',
      status: 'rejected'
    }
  ]);

  const [filter, setFilter] = React.useState('all');

  const filteredMaterials = materials => {
    if (filter === 'all') return materials;
    return materials.filter(m => m.status === filter);
  };

  const handleStatusChange = (id, newStatus) => {
    setMaterials(prev =>
      prev.map(m =>
        m.id === id ? {...m, status: newStatus} : m
      )
    );
    alert(`${t('decisionSaved')}`);
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

      <main className="materials-section">
        <div className="filters-bar">
          <div className="filter-group">
            <label>{t('filter')}</label>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">{t('all')}</option>
              <option value="pendingReview">{t('pendingReview')}</option>
              <option value="clarification">{t('clarification')}</option>
              <option value="approvedConditions">{t('approvedConditions')}</option>
              <option value="rejected">{t('rejected')}</option>
              <option value="delivered">{t('delivered')}</option>
            </select>
          </div>
          <button className="secondary-btn" onClick={() => setFilter('all')}>
            {t('clear')}
          </button>
        </div>

        <div className="materials-list">
          {filteredMaterials(materials).length > 0 ? (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>{t('request')}</th>
                    <th>{t('description')}</th>
                    <th>{t('quantity')}</th>
                    <th>{t('sender')}</th>
                    <th>{t('status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMaterials(materials).map((material) => (
                    <tr key={material.id}>
                      <td>{material.id}</td>
                      <td>{material.description}</td>
                      <td>{material.quantity}</td>
                      <td>{material.sender}</td>
                      <td>
                        <div className="status-badge-container">
                          <span
                            className={`status-badge ${material.status}`}
                            onClick={() => {
                              // Cycle through statuses for demo purposes
                              const statuses = ['pendingReview', 'clarification', 'approvedConditions', 'rejected', 'delivered'];
                              const currentIndex = statuses.indexOf(material.status);
                              const nextIndex = (currentIndex + 1) % statuses.length;
                              handleStatusChange(material.id, statuses[nextIndex]);
                            }}
                          >
                            {material.status.charAt(0).toUpperCase() + material.status.slice(1).replace(/([A-Z])/g, ' $1').toLowerCase()}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="no-results">{t('noResults')}</p>
          )}
        </div>

        {filteredMaterials(materials).length > 0 && (
          <div className="material-details">
            <h2>{filteredMaterials(materials)[0]?.description || 'Select a request'}</h2>
            <div className="details-grid">
              <div className="detail-item">
                <span>{t('description')}</span>
                <span>{filteredMaterials(materials)[0]?.description || ''}</span>
              </div>
              <div className="detail-item">
                <span>{t('quantity')}</span>
                <span>{filteredMaterials(materials)[0]?.quantity || ''}</span>
              </div>
              <div className="detail-item">
                <span>{t('weight')}</span>
                <span>{filteredMaterials(materials)[0]?.weight || ''}</span>
              </div>
              <div className="detail-item">
                <span>{t('dimensions')}</span>
                <span>{filteredMaterials(materials)[0]?.dimensions || ''}</span>
              </div>
              <div className="detail-item">
                <span>{t('sender')}</span>
                <span>{filteredMaterials(materials)[0]?.sender || ''}</span>
              </div>
              <div className="detail-item">
                <span>{t('receiver')}</span>
                <span>{filteredMaterials(materials)[0]?.receiver || ''}</span>
              </div>
            </div>

            <div className="decision-buttons">
              <button
                className="primary-btn"
                onClick={() => handleStatusChange(filteredMaterials(materials)[0]?.id || '', 'approvedConditions')}
                disabled={filteredMaterials(materials)[0]?.status === 'approvedConditions'}
              >
                {t('approveConditions')}
              </button>
              <button
                className="secondary-btn"
                onClick={() => handleStatusChange(filteredMaterials(materials)[0]?.id || '', 'clarification')}
                disabled={filteredMaterials(materials)[0]?.status === 'clarification'}
              >
                {t('requestClarification')}
              </button>
              <button
                className="secondary-btn"
                onClick={() => handleStatusChange(filteredMaterials(materials)[0]?.id || '', 'rejected')}
                disabled={filteredMaterials(materials)[0]?.status === 'rejected'}
              >
                {t('reject')}
              </button>
            </div>

            <p className="hint">{t('reasonForDecision')}</p>
            <textarea
              placeholder={t('reasonPlaceholder')}
              className="reason-input"
            />
            <p className="demo-note">{t('decisionSaved')}</p>
          </div>
        )}
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
    max-width: 1200px;
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

  .materials-section {
  }

  .filters-bar {
    display: flex;
    gap: 16px;
    margin-bottom: 24px;
    flex-wrap: wrap;
    align-items: center;
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
    min-width: 200px;
  }

  .secondary-btn {
    background: var(--ice);
    border: 2px solid var(--line);
    color: var(--ink);
    padding: 10px 16px;
    border-radius: var(--radius);
    font-weight: 600;
    cursor: pointer;
  }

  .secondary-btn:hover {
    background: var(--teal2);
    border-color: var(--teal);
    color: var(--teal);
  }

  .materials-list {
    margin-bottom: 24px;
  }

  .table-wrapper {
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 600px;
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

  .status-badge-container {
    position: relative;
    cursor: pointer;
  }

  .status-badge {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 500;
    text-align: center;
    min-width: 100px;
  }

  .status-badge.pendingreview { background: var(--bluebg); color: var(--blue); }
  .status-badge.clarification { background: var(--goldbg); color: var(--gold); }
  .status-badge.approvedconditions { background: var(--greenbg); color: var(--green); }
  .status-badge.rejected { background: var(--redbg); color: var(--red); }
  .status-badge.delivered { background: var(--teal2); color: var(--teal); }

  .materials-details {
    background: var(--ice);
    padding: 24px;
    border-radius: var(--radius);
  }

  .materials-details h2 {
    margin-bottom: 20px;
  }

  .details-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
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

  .decision-buttons {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }

  .reason-input {
    width: 100%;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font: inherit;
    margin-bottom: 12px;
  }

  .reason-input:focus {
    outline: 2px solid var(--teal);
  }

  .hint {
    font-size: 14px;
    color: var(--muted);
    margin-bottom: 12px;
  }

  .demo-note {
    font-size: 12px;
    color: var(--muted);
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

  @media (max-width: 768px) {
    .page-container {
      padding: 16px;
    }

    .page-header {
      flex-direction: column;
      gap: 16px;
      text-align: center;
    }

    .filters-bar {
      flex-direction: column;
      align-items: stretch;
    }

    .filter-group {
      width: 100%;
    }

    .details-grid {
      grid-template-columns: 1fr;
    }

    .decision-buttons {
      flex-direction: column;
      align-items: stretch;
    }
  }
`;

document.head.appendChild(style);

export default MaterialsView;