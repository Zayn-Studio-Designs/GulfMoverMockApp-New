import { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { useDemo, type MaterialDecision } from '../context/DemoContext';
import { useUi } from '../context/UiContext';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { toCsv, downloadCsv } from '../domain/csv';

export default function MaterialsView() {
  const { t, tx } = useLanguage();
  const { materials, decideMaterial } = useDemo();
  const { toast, openModal } = useUi();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = materials.find(m => m.id === selectedId) ?? materials[0];

  // Submission is never acceptance: every decision is an explicit reviewer action with a reason.
  const decide = (decision: MaterialDecision) => openModal({
    title: decision === 'approved' ? t('approveConditions') : decision === 'clarification' ? t('requestClarification') : t('reject'),
    desc: t('reasonForDecision'), confirmText: t('confirm'), requireReason: true,
    onConfirm: reason => { decideMaterial(selected.id, decision, reason); toast(t('decisionSaved')); },
  });

  const lines: Array<[string, string]> = [
    ['description', selected.detail], ['quantity', selected.qty], ['weight', selected.weight],
    ['dimensions', selected.size], ['sender', selected.sender], ['receiver', selected.receiver],
  ];

  return (
    <>
      <PageHeader titleKey="materialsTitle" subKey="materialsSub" />
      <div className="notice warn" style={{ marginBottom: 16 }}><strong>{t('materialsPending')}</strong>{t('materialsSub')}</div>
      <div className="split">
        <div className="card card-pad">
          <div className="between">
            <h2 className="card-title">{t('materialsTitle')}</h2>
            <span className="pill pill-neutral">{materials.length} {tx('demo request(s)')}</span>
          </div>
          <button type="button" className="btn btn-outline btn-small" style={{ marginBottom: 10 }}
            onClick={() => { if (downloadCsv('gulf-mover-demo-materials.csv', toCsv(
              ['ID', 'Name', 'Qty', 'Weight', 'Size', 'Status', 'Sender', 'Receiver'],
              materials.map(m => [m.id, m.name, m.qty, m.weight, m.size, m.status, m.sender, m.receiver])))) toast(tx('Export downloads the current demo data only.')); }}>
            {t('exportMaterials')}
          </button>
          {materials.map(m => (
            <button key={m.id} type="button" className="request-row" aria-pressed={m.id === selected.id}
              style={{ width: '100%', textAlign: 'start', border: 0, background: m.id === selected.id ? '#f1f8f3' : 'transparent', cursor: 'pointer' }}
              onClick={() => setSelectedId(m.id)}>
              <div>
                <div className="request-title">{tx(m.name)}</div>
                <div className="request-meta"><span className="mono">{m.id}</span> · {tx(m.qty)} · {tx(m.sender)}</div>
              </div>
              <StatusPill text={m.status} />
            </button>
          ))}
        </div>
        <div className="card card-pad">
          <div className="eyebrow">{t('request')} · {tx('DEMO')}</div>
          <h2 className="card-title">{tx(selected.name)}</h2>
          <p className="card-desc mono">{selected.id}</p>
          <div className="divider" />
          {lines.map(([key, val]) => (
            <div key={key} className="price-line"><span>{t(key)}</span><strong>{tx(val)}</strong></div>
          ))}
          <div className="notice" style={{ marginTop: 14 }}>{tx('Submission is not acceptance. Do not treat sample details as evidence that any real item is permitted or suitable for the vessel.')}</div>
          <div className="grid" style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-primary" onClick={() => decide('approved')}>{t('approveConditions')}</button>
            <button type="button" className="btn btn-outline" onClick={() => decide('clarification')}>{t('requestClarification')}</button>
            <button type="button" className="btn btn-danger" onClick={() => decide('rejected')}>{t('reject')}</button>
          </div>
        </div>
      </div>
    </>
  );
}
