import { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { usePlatformRoles } from '../context/OnboardingContext';
import type { TransferRequest } from '../lib/operationsService';
import {
  ATTACHMENT_MAX_BYTES, allocateCharter, approveMaterialQuote, assignMaterial, attachmentUrl, cancelTransfer, listOpenSailingsLite,
  listVesselsLite, quoteMaterial, recordMaterialDelivery, recordSafetyReview, transferExtras, uploadRequestAttachment,
} from '../lib/phase8Service';
import { formatSar } from '../domain/money';
import { FlashNotice, ReasonField, useAction, useLoad } from './StaffKit';

/**
 * Phase 8 actions on one material or charter request. Customers see the quote,
 * upload private attachments and may cancel before scheduling. ATCO staff record
 * the mandatory safety review, quote, approve, assign to a sailing within the
 * payload limit, record delivery proof, or allocate a vessel for a charter.
 */
export function TransferActions({ request, admin, onChanged }: { request: TransferRequest; admin: boolean; onChanged: () => void }) {
  const { t, lang } = useLanguage();
  const roles = usePlatformRoles() ?? [];
  const isOps = roles.includes('super_admin') || roles.includes('operations');
  const isFinance = roles.includes('super_admin') || roles.includes('finance');
  const extras = useLoad(() => transferExtras(request.id), [request.id, request.revision]);
  const vessels = useLoad(() => (admin && request.kind === 'charter' ? listVesselsLite() : Promise.resolve([])), [admin, request.kind]);
  const sailings = useLoad(() => (admin && request.kind === 'materials' ? listOpenSailingsLite() : Promise.resolve([])), [admin, request.kind]);
  const { busy, flash, run } = useAction(async () => { await extras.reload(); onChanged(); });
  const [reason, setReason] = useState('');
  const [permit, setPermit] = useState('');
  const [sailingId, setSailingId] = useState('');
  const [receiver, setReceiver] = useState('');
  const [signature, setSignature] = useState('');
  const [charter, setCharter] = useState({ vessel: '', start: '', end: '', quote: '' });
  const x = extras.data;
  const need = !reason.trim();
  const sar = (v: string) => { const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v.trim()); return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null; };

  return (
    <div className="inset small" style={{ marginTop: 12 }}>
      {x && request.kind === 'materials' && (
        <div className="status-grid">
          <div className="status-item"><div className="status-label">{t('p5Field_weight_kg')}</div><div className="status-text">{x.weightKg ?? '—'}</div></div>
          <div className="status-item"><div className="status-label">{t('p8SafetyReview')}</div><div className="status-text">{t(`p8Safety_${x.safetyDecision}`)}{x.safetyReference ? ` · ${x.safetyReference}` : ''}</div></div>
          <div className="status-item"><div className="status-label">{t('p8Quote')}</div><div className="status-text">{x.quote ? `${formatSar(x.quote.totalHalala, lang)} · ${t(`p8Quote_${x.quote.status}`)}` : '—'}</div></div>
        </div>
      )}
      {x?.declaredHazardous && <div className="notice warn" style={{ marginTop: 8 }}>{t('p8HazardNotice')}</div>}
      {x?.allocation && <p style={{ marginTop: 8 }}>{t('p8Allocated')}: {new Date(x.allocation.startsAt).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh' })} → {new Date(x.allocation.endsAt).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh' })}{x.allocation.quotedTotalHalala !== null ? ` · ${formatSar(x.allocation.quotedTotalHalala, lang)}` : ''}</p>}
      {request.kind === 'charter' && !x?.allocation && <p className="muted" style={{ marginTop: 8 }}>{t('p8CharterNotConfirmed')}</p>}

      {x && x.attachments.length > 0 && (
        <ul style={{ marginTop: 8 }}>{x.attachments.map(a => (
          <li key={a.id}><button type="button" className="link-btn" onClick={() => void attachmentUrl(a.objectPath).then(u => window.open(u, '_blank', 'noopener'))}>{a.objectPath.split('/').pop()}</button> ({Math.ceil(a.sizeBytes / 1024)} KB)</li>
        ))}</ul>
      )}
      {!admin && ['pending_review', 'clarification_required'].includes(request.status) && (
        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor={`att-${request.id}`}>{t('p8AddAttachment')}</label>
          <input id={`att-${request.id}`} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(() => uploadRequestAttachment(request.organization_id, request.id, f), 'p8AttachmentSaved'); }} />
          <small>{t('p8AttachmentHint').replace('{mb}', String(ATTACHMENT_MAX_BYTES / 1024 / 1024))}</small>
        </div>
      )}

      <ReasonField id={`ta-reason-${request.id}`} value={reason} onChange={setReason} />
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {!['cancelled', 'rejected', 'delivered', 'completed'].includes(request.status) && (admin ? isOps : !['scheduled', 'confirmed'].includes(request.status)) &&
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => cancelTransfer(request.id, reason))}>{t('p8CancelRequest')}</button>}
        {admin && isOps && request.kind === 'materials' && ['pending_review', 'clarification_required', 'reviewed_for_planning'].includes(request.status) && <>
          <input aria-label={t('p8PermitReference')} placeholder={t('p8PermitReference')} value={permit} onChange={e => setPermit(e.target.value)} style={{ width: 160 }} />
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => recordSafetyReview(request.id, 'accepted', permit, reason))}>{t('p8SafetyAccept')}</button>
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => recordSafetyReview(request.id, 'refused', permit, reason))}>{t('p8SafetyRefuse')}</button>
        </>}
        {admin && (isOps || isFinance) && request.kind === 'materials' && !['cancelled', 'rejected', 'delivered'].includes(request.status) &&
          <button type="button" className="btn btn-outline btn-small" disabled={busy} onClick={() => void run(() => quoteMaterial(request.id))}>{t('p8CalculateQuote')}</button>}
        {admin && isFinance && x?.quote?.status === 'indicative' &&
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need} onClick={() => void run(() => approveMaterialQuote(x.quote!.id, reason))}>{t('p8ApproveQuote')}</button>}
        {admin && isOps && request.kind === 'materials' && request.status === 'approved' && <>
          <select aria-label={t('p8AssignSailing')} value={sailingId} onChange={e => setSailingId(e.target.value)}>
            <option value="">{t('p8AssignSailing')}</option>
            {(sailings.data ?? []).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need || !sailingId} onClick={() => void run(() => assignMaterial(request.id, sailingId, reason))}>{t('p8Assign')}</button>
        </>}
        {admin && isOps && request.kind === 'materials' && request.status === 'scheduled' && <>
          <input aria-label={t('p8ReceiverName')} placeholder={t('p8ReceiverName')} value={receiver} onChange={e => setReceiver(e.target.value)} style={{ width: 160 }} />
          <input aria-label={t('p8SignatureRef')} placeholder={t('p8SignatureRef')} value={signature} onChange={e => setSignature(e.target.value)} style={{ width: 160 }} />
          <button type="button" className="btn btn-outline btn-small" disabled={busy || !receiver.trim()} onClick={() => void run(() => recordMaterialDelivery(request.id, receiver, signature, reason))}>{t('p8RecordDelivery')}</button>
        </>}
        {admin && isOps && request.kind === 'charter' && request.status === 'approved' && <>
          <select aria-label={t('p8Vessel')} value={charter.vessel} onChange={e => setCharter({ ...charter, vessel: e.target.value })}>
            <option value="">{t('p8Vessel')}</option>{(vessels.data ?? []).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
          <input aria-label={t('p8Start')} type="datetime-local" value={charter.start} onChange={e => setCharter({ ...charter, start: e.target.value })} />
          <input aria-label={t('p8End')} type="datetime-local" value={charter.end} onChange={e => setCharter({ ...charter, end: e.target.value })} />
          <input aria-label={t('p8QuotedSar')} placeholder={t('p8QuotedSar')} dir="ltr" value={charter.quote} onChange={e => setCharter({ ...charter, quote: e.target.value })} style={{ width: 120 }} />
          <button type="button" className="btn btn-outline btn-small" disabled={busy || need || !charter.vessel || !charter.start || !charter.end}
            onClick={() => void run(() => allocateCharter(request.id, charter.vessel, `${charter.start}:00+03:00`, `${charter.end}:00+03:00`, charter.quote ? sar(charter.quote) : null, reason))}>{t('p8Allocate')}</button>
        </>}
      </div>
      <FlashNotice flash={flash} />
    </div>
  );
}
