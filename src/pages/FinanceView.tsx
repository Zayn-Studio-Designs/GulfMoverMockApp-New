import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import {
  adjustSettlement, approveCommissionRule, approveTariff, decideRefund, decideSettlement, generateSettlement, listApprovedOrganizations,
  listCommissionRules, listPolicies, listRecentInvoices, listRefunds, listSettings, listSettlements, listTariffs, proposeCommissionRule,
  publishTariff, recordAccountPayment, retireTariff, setAccountType, setCreditStatus, setCreditTerms, setPolicyStatus, updateSetting,
} from '../lib/phase8Service';
import { formatSar } from '../domain/money';
import { ProdPageHeader } from '../components/ProductionUi';
import { FlashNotice, ReasonField, RequireRoles, todayRiyadh, useAction, useLoad } from '../components/StaffKit';

/**
 * Finance administration (`/admin/finance`): versioned tariffs with four-eyes
 * approval, refund decisions (policy-gated), corporate credit, on-account
 * settlement, agent settlements/commission rules (inactive until approved),
 * policy approval and seller identity. Every action is audited server-side.
 */
const TABS = ['tariffs', 'refunds', 'credit', 'invoices', 'settlements', 'policies'] as const;
type Tab = typeof TABS[number];
const sarToHalala = (v: string): number | null => {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};

function TariffsTab() {
  const { t, lang } = useLanguage();
  const { data, error, reload } = useLoad(listTariffs, []);
  const { busy, flash, run } = useAction(reload);
  const [form, setForm] = useState({ code: '', fare: '500.00', vatMode: 'not_configured', vatRate: '', from: todayRiyadh(1), reason: '' });
  const [reason, setReason] = useState('');
  const fare = sarToHalala(form.fare);
  return (
    <>
      <section className="card card-pad">
        <h2 className="card-title">{t('p8PublishTariff')}</h2>
        <p className="card-desc">{t('p8PublishTariffBody')}</p>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div className="field"><label htmlFor="tf-code">{t('p8Code')} *</label><input id="tf-code" maxLength={64} value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} /></div>
          <div className="field"><label htmlFor="tf-fare">{t('p8FarePerLeg')} (SAR) *</label><input id="tf-fare" inputMode="decimal" dir="ltr" value={form.fare} onChange={e => setForm({ ...form, fare: e.target.value })} /></div>
          <div className="field"><label htmlFor="tf-vat">{t('p8VatTreatment')}</label>
            <select id="tf-vat" value={form.vatMode} onChange={e => setForm({ ...form, vatMode: e.target.value })}>
              {['not_configured', 'exclusive', 'inclusive', 'exempt', 'zero_rated'].map(m => <option key={m} value={m}>{t(`p8Vat_${m}`)}</option>)}
            </select></div>
          {['exclusive', 'inclusive'].includes(form.vatMode) && <div className="field"><label htmlFor="tf-rate">{t('p8VatRate')} (%) *</label><input id="tf-rate" inputMode="decimal" dir="ltr" value={form.vatRate} onChange={e => setForm({ ...form, vatRate: e.target.value })} /></div>}
          <div className="field"><label htmlFor="tf-from">{t('p8EffectiveFrom')}</label><input id="tf-from" type="date" value={form.from} onChange={e => setForm({ ...form, from: e.target.value })} /></div>
          <ReasonField id="tf-reason" value={form.reason} onChange={v => setForm({ ...form, reason: v })} />
        </div>
        <button type="button" className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy || !form.code.trim() || fare === null || !form.reason.trim()}
          onClick={() => void run(() => publishTariff({ code: form.code.trim(), perPersonHalala: fare!, vatMode: form.vatMode,
            vatRateBp: ['exclusive', 'inclusive'].includes(form.vatMode) ? Math.round(Number(form.vatRate) * 100) : null,
            effectiveFrom: `${form.from}T00:00:00+03:00`, reason: form.reason }))}>{t('p8Publish')}</button>
        <FlashNotice flash={flash} />
      </section>
      <section className="card card-pad">
        <h2 className="card-title">{t('p8TariffVersions')}</h2>
        {error && <div className="notice danger" role="alert">{t(error)}</div>}
        <ReasonField id="tf-decision-reason" value={reason} onChange={setReason} />
        {(data ?? []).map(tf => (
          <div key={tf.id} className="request-row">
            <div><div className="request-title mono">{tf.code}</div>
              <div className="request-meta">{formatSar(tf.perPersonHalala, lang)} · {t(`p8Vat_${tf.vatMode}`)}{tf.vatRateBp ? ` ${(tf.vatRateBp / 100).toFixed(2)}%` : ''} · {t('p8EffectiveFrom')} {tf.effectiveFrom.slice(0, 10)}</div></div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <span className={`pill ${tf.approvalStatus === 'approved' ? 'pill-green' : tf.approvalStatus === 'retired' ? 'pill-neutral' : 'pill-gold'}`}>{t(`p8Policy_${tf.approvalStatus}`)}</span>
              {tf.approvalStatus === 'provisional' && <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim()} onClick={() => void run(() => approveTariff(tf.id, reason))}>{t('p8Approve')}</button>}
              {tf.approvalStatus !== 'retired' && <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim()} onClick={() => void run(() => retireTariff(tf.id, reason))}>{t('p8Retire')}</button>}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

function RefundsTab() {
  const { t, lang } = useLanguage();
  const { data, error, reload } = useLoad(() => listRefunds({}), []);
  const { busy, flash, run } = useAction(reload);
  const [reason, setReason] = useState('');
  return (
    <section className="card card-pad">
      <h2 className="card-title">{t('p8RefundQueue')}</h2>
      <p className="card-desc">{t('p8RefundQueueBody')}</p>
      {error && <div className="notice danger" role="alert">{t(error)}</div>}
      <ReasonField id="rf-reason" value={reason} onChange={setReason} />
      <FlashNotice flash={flash} />
      {(data ?? []).length === 0 && <div className="no-data">{t('p8NoRows')}</div>}
      {(data ?? []).map(r => (
        <div key={r.id} className="request-row">
          <div><div className="request-title"><Link to={`/bookings/${r.bookingReference}`} className="mono">{r.bookingReference}</Link> · {formatSar(r.amountHalala, lang)}{r.sandbox ? ` · ${t('p8Sandbox')}` : ''}</div><div className="request-meta">{r.reason}</div></div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="pill pill-neutral">{t(`p8Rf_${r.status}`)}</span>
            {r.status === 'pending_review' && <>
              <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim()} onClick={() => void run(() => decideRefund(r.id, 'approve', reason))}>{t('p8Approve')}</button>
              <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim()} onClick={() => void run(() => decideRefund(r.id, 'reject', reason))}>{t('p8Reject')}</button>
            </>}
          </div>
        </div>
      ))}
    </section>
  );
}

function CreditTab() {
  const { t, lang } = useLanguage();
  const { data, error, reload } = useLoad(listApprovedOrganizations, []);
  const { busy, flash, run } = useAction(reload);
  const [edit, setEdit] = useState<Record<string, { limit: string; terms: string }>>({});
  const [reason, setReason] = useState('');
  return (
    <section className="card card-pad">
      <h2 className="card-title">{t('p8CreditTitle')}</h2>
      <p className="card-desc">{t('p8CreditBody')}</p>
      {error && <div className="notice danger" role="alert">{t(error)}</div>}
      <ReasonField id="cr-reason" value={reason} onChange={setReason} />
      <FlashNotice flash={flash} />
      {(data ?? []).map(o => {
        const e = edit[o.id] ?? { limit: o.creditLimitHalala === null ? '' : (o.creditLimitHalala / 100).toFixed(2), terms: o.paymentTermsDays === null ? '' : String(o.paymentTermsDays) };
        const limit = e.limit.trim() === '' ? null : sarToHalala(e.limit);
        const terms = e.terms.trim() === '' ? null : Number(e.terms);
        return (
          <div key={o.id} className="request-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div><div className="request-title">{o.name}</div><div className="request-meta">{t(o.accountType === 'agent' ? 'p8AccountAgent' : 'p8AccountCorporate')} · {t(`p8Credit_${o.creditStatus}`)}{o.creditLimitHalala !== null ? ` · ${formatSar(o.creditLimitHalala, lang)}` : ''}</div></div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <label className="sr-only" htmlFor={`cl-${o.id}`}>{t('p8ColLimit')}</label>
              <input id={`cl-${o.id}`} style={{ width: 120 }} dir="ltr" placeholder={t('p8ColLimit')} value={e.limit} onChange={ev => setEdit({ ...edit, [o.id]: { ...e, limit: ev.target.value } })} />
              <label className="sr-only" htmlFor={`ct-${o.id}`}>{t('p8TermsDays')}</label>
              <input id={`ct-${o.id}`} style={{ width: 80 }} dir="ltr" placeholder={t('p8TermsDays')} value={e.terms} onChange={ev => setEdit({ ...edit, [o.id]: { ...e, terms: ev.target.value } })} />
              <button type="button" className="btn btn-outline btn-small" disabled={busy || (e.limit.trim() !== '' && limit === null) || (terms !== null && !(Number.isInteger(terms) && terms >= 0 && terms <= 365))}
                onClick={() => void run(() => setCreditTerms(o.id, limit, terms))}>{t('p8SaveTerms')}</button>
              <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim()} onClick={() => void run(() => setCreditStatus(o.id, 'active', reason))}>{t('p8Activate')}</button>
              <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim()} onClick={() => void run(() => setCreditStatus(o.id, 'on_hold', reason))}>{t('p8Hold')}</button>
              <button type="button" className="btn btn-outline btn-small" disabled={busy} onClick={() => void run(() => setAccountType(o.id, o.accountType === 'agent' ? 'corporate' : 'agent'))}>{t(o.accountType === 'agent' ? 'p8MakeCorporate' : 'p8MakeAgent')}</button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function InvoicesTab() {
  const { t, lang } = useLanguage();
  const [filter, setFilter] = useState('on_account_open');
  const { data, error, reload } = useLoad(() => listRecentInvoices(filter === 'on_account_open' ? { settlementMode: 'on_account', status: 'issued' } : {}), [filter]);
  const { busy, flash, run } = useAction(reload);
  const [pay, setPay] = useState<Record<string, { amount: string; ref: string }>>({});
  return (
    <section className="card card-pad">
      <div className="between"><h2 className="card-title">{t('p8InvoicesTitle')}</h2>
        <select aria-label={t('p8Filter')} value={filter} onChange={e => setFilter(e.target.value)}><option value="on_account_open">{t('p8OpenOnAccount')}</option><option value="all">{t('p8AllRecent')}</option></select></div>
      {error && <div className="notice danger" role="alert">{t(error)}</div>}
      <FlashNotice flash={flash} />
      {(data ?? []).length === 0 && <div className="no-data">{t('p8NoRows')}</div>}
      {(data ?? []).map(i => {
        const p = pay[i.id] ?? { amount: ((i.totalHalala - i.amountPaidHalala) / 100).toFixed(2), ref: '' };
        const amount = sarToHalala(p.amount);
        return (
          <div key={i.id} className="request-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div><div className="request-title"><Link to={`/invoices/${i.id}`} className="mono">{i.invoiceNumber}</Link></div>
              <div className="request-meta">{String(i.buyer.name ?? '')} · {formatSar(i.totalHalala, lang)} · {t('p8Paid')} {formatSar(i.amountPaidHalala, lang)}{i.dueDate ? ` · ${t('p8DueDate')} ${i.dueDate}` : ''}</div></div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <span className="pill pill-neutral">{t(`p8Inv_${i.status}`)}</span>
              {i.settlementMode === 'on_account' && ['issued', 'partially_paid'].includes(i.status) && <>
                <input aria-label={t('p8ColAmount')} style={{ width: 110 }} dir="ltr" value={p.amount} onChange={e => setPay({ ...pay, [i.id]: { ...p, amount: e.target.value } })} />
                <input aria-label={t('p8BankReference')} style={{ width: 140 }} placeholder={t('p8BankReference')} value={p.ref} onChange={e => setPay({ ...pay, [i.id]: { ...p, ref: e.target.value } })} />
                <button type="button" className="btn btn-outline btn-small" disabled={busy || amount === null || !p.ref.trim()} onClick={() => void run(() => recordAccountPayment(i.id, amount!, p.ref))}>{t('p8RecordPayment')}</button>
              </>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function SettlementsTab() {
  const { t, lang } = useLanguage();
  const orgs = useLoad(listApprovedOrganizations, []);
  const { data, error, reload } = useLoad(listSettlements, []);
  const rules = useLoad(listCommissionRules, []);
  const { busy, flash, run } = useAction(async () => { await reload(); await rules.reload(); });
  const agents = (orgs.data ?? []).filter(o => o.accountType === 'agent');
  const [gen, setGen] = useState({ org: '', from: todayRiyadh(-30), to: todayRiyadh(0) });
  const [rule, setRule] = useState({ org: '', basis: 'percent_of_net_bp', value: '', from: todayRiyadh(0) });
  const [reason, setReason] = useState('');
  const [ref, setRef] = useState('');
  const [adj, setAdj] = useState('');
  const agentName = (id: string | null) => id === null ? t('p8AllAgents') : agents.find(a => a.id === id)?.name ?? id.slice(0, 8);
  return (
    <>
      <section className="card card-pad">
        <h2 className="card-title">{t('p8CommissionRules')}</h2>
        <div className="notice warn">{t('p8CommissionInactive')}</div>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div className="field"><label htmlFor="cr-org">{t('p8ColOrganization')}</label><select id="cr-org" value={rule.org} onChange={e => setRule({ ...rule, org: e.target.value })}><option value="">{t('p8AllAgents')}</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div className="field"><label htmlFor="cr-basis">{t('p8Basis')}</label><select id="cr-basis" value={rule.basis} onChange={e => setRule({ ...rule, basis: e.target.value })}><option value="percent_of_net_bp">{t('p8BasisPercent')}</option><option value="per_passenger_halala">{t('p8BasisPerPassenger')}</option></select></div>
          <div className="field"><label htmlFor="cr-value">{t('p8Value')}</label><input id="cr-value" dir="ltr" inputMode="decimal" value={rule.value} onChange={e => setRule({ ...rule, value: e.target.value })} /><small>{rule.basis === 'percent_of_net_bp' ? t('p8PercentHint') : t('p8SarHint')}</small></div>
          <div className="field"><label htmlFor="cr-from">{t('p8EffectiveFrom')}</label><input id="cr-from" type="date" value={rule.from} onChange={e => setRule({ ...rule, from: e.target.value })} /></div>
        </div>
        <button type="button" className="btn btn-outline" style={{ marginTop: 10 }} disabled={busy || !rule.value}
          onClick={() => void run(() => proposeCommissionRule(rule.org || null, rule.basis, rule.basis === 'percent_of_net_bp' ? Math.round(Number(rule.value) * 100) : sarToHalala(rule.value) ?? 0, rule.from, 'Proposed in Finance console'))}>{t('p8Propose')}</button>
        {(rules.data ?? []).map(r => (
          <div key={r.id} className="request-row">
            <div><div className="request-title">{agentName(r.agentOrganizationId)}</div><div className="request-meta">{r.basis === 'percent_of_net_bp' ? `${(r.value / 100).toFixed(2)}%` : formatSar(r.value, lang)} · {r.effectiveFrom}</div></div>
            <div className="row"><span className="pill pill-neutral">{t(`p8Policy_${r.status}`)}</span>
              {r.status === 'provisional' && <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim()} onClick={() => void run(() => approveCommissionRule(r.id, reason))}>{t('p8Approve')}</button>}</div>
          </div>
        ))}
      </section>
      <section className="card card-pad">
        <h2 className="card-title">{t('p8SettlementsTitle')}</h2>
        {error && <div className="notice danger" role="alert">{t(error)}</div>}
        <div className="form-grid">
          <div className="field"><label htmlFor="st-org">{t('p8ColOrganization')}</label><select id="st-org" value={gen.org} onChange={e => setGen({ ...gen, org: e.target.value })}><option value="">{t('pbChoose')}</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div className="field"><label htmlFor="st-from">{t('p8From')}</label><input id="st-from" type="date" value={gen.from} onChange={e => setGen({ ...gen, from: e.target.value })} /></div>
          <div className="field"><label htmlFor="st-to">{t('p8To')}</label><input id="st-to" type="date" value={gen.to} onChange={e => setGen({ ...gen, to: e.target.value })} /></div>
        </div>
        <button type="button" className="btn btn-outline" style={{ marginTop: 10 }} disabled={busy || !gen.org} onClick={() => void run(() => generateSettlement(gen.org, gen.from, gen.to))}>{t('p8Generate')}</button>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <ReasonField id="st-reason" value={reason} onChange={setReason} />
          <div className="field"><label htmlFor="st-ref">{t('p8PaymentReference')}</label><input id="st-ref" value={ref} onChange={e => setRef(e.target.value)} /></div>
          <div className="field"><label htmlFor="st-adj">{t('p8AdjustmentSar')}</label><input id="st-adj" dir="ltr" value={adj} onChange={e => setAdj(e.target.value)} placeholder="-25.00" /></div>
        </div>
        <FlashNotice flash={flash} />
        {(data ?? []).map(s => (
          <div key={s.id} className="request-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div><div className="request-title">{agentName(s.agentOrganizationId)} · {s.periodStart} → {s.periodEnd}</div>
              <div className="request-meta">{t('p8Gross')} {formatSar(s.grossHalala, lang)} · {t('p8Vat')} {formatSar(s.vatHalala, lang)} · {t('p8ColRefunded')} {formatSar(s.refundsHalala, lang)} · {t('p8ColFees')} {formatSar(s.paymentChargesHalala, lang)} · {t('p8Commission')} {formatSar(s.commissionHalala, lang)} · {t('p8Adjustments')} {formatSar(s.adjustmentsHalala, lang)} · <strong>{t('p8NetDue')} {formatSar(s.netDueHalala, lang)}</strong>{s.commissionStatus === 'no_approved_rule' ? ` · ${t('p8NoApprovedRule')}` : ''}</div></div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <span className="pill pill-neutral">{t(`p8St_${s.status}`)}</span>
              {s.status === 'draft' && <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim() || !/^-?\d+(\.\d{1,2})?$/.test(adj.trim())}
                onClick={() => void run(() => adjustSettlement(s.id, Math.round(Number(adj) * 100), reason))}>{t('p8Adjust')}</button>}
              {s.status === 'draft' && <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim()} onClick={() => void run(() => decideSettlement(s.id, 'approve', null, reason))}>{t('p8Approve')}</button>}
              {s.status === 'approved' && <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim() || !ref.trim()} onClick={() => void run(() => decideSettlement(s.id, 'mark_paid', ref, reason))}>{t('p8MarkPaid')}</button>}
              {s.status !== 'paid' && s.status !== 'void' && <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim()} onClick={() => void run(() => decideSettlement(s.id, 'void', null, reason))}>{t('p8Void')}</button>}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

function PoliciesTab() {
  const { t } = useLanguage();
  const policies = useLoad(listPolicies, []);
  const settings = useLoad(listSettings, []);
  const { busy, flash, run } = useAction(async () => { await policies.reload(); await settings.reload(); });
  const [reason, setReason] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const editable = ['seller.legal_name', 'seller.vat_number', 'sailing.minimum_tickets', 'sailing.minimum_revenue_halala', 'sailing.minimum_counts',
    'booking.confirmation_deadline_hours', 'booking.payment_hold_minutes', 'booking.customer_change_cutoff_hours', 'payload.passenger_allowance_kg'];
  const parse = (key: string, raw: string): unknown => {
    if (raw.trim() === '') return null;
    if (['seller.legal_name', 'seller.vat_number', 'sailing.minimum_counts'].includes(key)) return raw.trim();
    return Number(raw);
  };
  return (
    <>
      <section className="card card-pad">
        <h2 className="card-title">{t('p8SettingsTitle')}</h2>
        <p className="card-desc">{t('p8SettingsBody')}</p>
        <ReasonField id="set-reason" value={reason} onChange={setReason} />
        <FlashNotice flash={flash} />
        {(settings.data ?? []).filter(s => editable.includes(s.key)).map(s => (
          <div key={s.key} className="request-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div><div className="request-title mono">{s.key}</div><div className="request-meta">{s.description}</div></div>
            <div className="row">
              <input aria-label={s.key} style={{ width: 220 }} dir="ltr" value={values[s.key] ?? (s.value === null || s.value === undefined ? '' : String(s.value))}
                onChange={e => setValues({ ...values, [s.key]: e.target.value })} />
              <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim() || values[s.key] === undefined}
                onClick={() => void run(() => updateSetting(s.key, parse(s.key, values[s.key] ?? ''), reason))}>{t('p8Save')}</button>
            </div>
          </div>
        ))}
      </section>
      <section className="card card-pad">
        <h2 className="card-title">{t('p8PoliciesTitle')}</h2>
        <div className="notice warn">{t('p8PoliciesBody')}</div>
        {(policies.data ?? []).map(p => (
          <div key={`${p.policyType}-${p.version}`} className="request-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div><div className="request-title">{p.policyType} · <span className="mono">{p.version}</span></div><div className="request-meta" style={{ maxWidth: 560, overflowWrap: 'anywhere' }}>{JSON.stringify(p.content).slice(0, 220)}</div></div>
            <div className="row"><span className="pill pill-neutral">{t(`p8Policy_${p.status}`)}</span>
              {p.status === 'provisional' && <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim()} onClick={() => void run(() => setPolicyStatus(p.policyType, p.version, 'approved', reason))}>{t('p8Approve')}</button>}
              {p.status !== 'retired' && <button type="button" className="btn btn-outline btn-small" disabled={busy || !reason.trim()} onClick={() => void run(() => setPolicyStatus(p.policyType, p.version, 'retired', reason))}>{t('p8Retire')}</button>}</div>
          </div>
        ))}
      </section>
    </>
  );
}

export default function FinanceView() {
  const { t } = useLanguage();
  const [tab, setTab] = useState<Tab>('tariffs');
  return (
    <>
      <ProdPageHeader titleKey="p8FinanceTitle" subKey="p8FinanceSub" />
      <RequireRoles roles={['super_admin', 'finance']}>
        <div className="tabs" role="tablist" aria-label={t('p8FinanceTitle')} style={{ marginBottom: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TABS.map(id => <button key={id} type="button" role="tab" aria-selected={tab === id} className={`btn btn-small ${tab === id ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab(id)}>{t(`p8Tab_${id}`)}</button>)}
        </div>
        <div className="grid" role="tabpanel">
          {tab === 'tariffs' && <TariffsTab />}
          {tab === 'refunds' && <RefundsTab />}
          {tab === 'credit' && <CreditTab />}
          {tab === 'invoices' && <InvoicesTab />}
          {tab === 'settlements' && <SettlementsTab />}
          {tab === 'policies' && <PoliciesTab />}
        </div>
      </RequireRoles>
    </>
  );
}
