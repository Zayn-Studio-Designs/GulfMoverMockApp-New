import { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { usePlatformRoles } from '../context/OnboardingContext';
import { runReport } from '../lib/phase8Service';
import { formatSar } from '../domain/money';
import { ProdPageHeader } from '../components/ProductionUi';
import { DataTable, RequireRoles, todayRiyadh, useLoad, type Column } from '../components/StaffKit';

/**
 * Management reports (`/admin/reports`). Every figure is computed by role-gated
 * database functions from persisted records, using Asia/Riyadh dates. Finance-only
 * reports are hidden for operations, and the database refuses them anyway.
 */

type ReportDef = { id: string; fn: string; titleKey: string; roles: readonly string[]; args: (from: string, to: string) => Record<string, unknown>; columns: Array<[string, string, boolean?]> };

const REPORTS: ReportDef[] = [
  { id: 'daily', fn: 'report_period_summary', titleKey: 'p8RepDaily', roles: ['super_admin', 'finance', 'operations'], args: (f, t) => ({ p_from: f, p_to: t, p_grain: 'day' }),
    columns: [['period', 'p8ColPeriod'], ['sailings', 'p8ColSailings'], ['seat_capacity', 'p8ColCapacity'], ['tickets_issued', 'p8ColTickets'], ['passengers_boarded', 'p8ColBoarded'], ['no_shows', 'p8ColNoShows'],
      ['bookings_created', 'p8ColBookings'], ['bookings_cancelled', 'p8ColCancelled'], ['gross_collected_halala', 'p8ColCollected', true], ['refunded_halala', 'p8ColRefunded', true],
      ['on_account_invoiced_halala', 'p8ColOnAccount', true], ['materials_delivered_kg', 'p8ColMaterialsKg']] },
  { id: 'monthly', fn: 'report_period_summary', titleKey: 'p8RepMonthly', roles: ['super_admin', 'finance', 'operations'], args: (f, t) => ({ p_from: f, p_to: t, p_grain: 'month' }),
    columns: [['period', 'p8ColPeriod'], ['sailings', 'p8ColSailings'], ['tickets_issued', 'p8ColTickets'], ['passengers_boarded', 'p8ColBoarded'], ['bookings_cancelled', 'p8ColCancelled'],
      ['gross_collected_halala', 'p8ColCollected', true], ['refunded_halala', 'p8ColRefunded', true], ['materials_delivered_kg', 'p8ColMaterialsKg']] },
  { id: 'occupancy', fn: 'report_sailing_occupancy', titleKey: 'p8RepOccupancy', roles: ['super_admin', 'finance', 'operations'], args: (f, t) => ({ p_from: f, p_to: t }),
    columns: [['departs_at', 'p8ColDeparture'], ['origin', 'p8ColOrigin'], ['destination', 'p8ColDestination'], ['seat_capacity', 'p8ColCapacity'], ['seats_booked', 'p8ColSeatsBooked'], ['ticket_count', 'p8ColTickets'], ['threshold_met', 'p8ColMinimum']] },
  { id: 'revenue-sailing', fn: 'report_revenue_by_sailing', titleKey: 'p8RepRevenueSailing', roles: ['super_admin', 'finance', 'operations'], args: (f, t) => ({ p_from: f, p_to: t }),
    columns: [['departs_at', 'p8ColDeparture'], ['bookings', 'p8ColBookings'], ['passengers', 'p8ColPassengers'], ['collected_halala', 'p8ColCollected', true], ['refunded_halala', 'p8ColRefunded', true]] },
  { id: 'revenue-destination', fn: 'report_revenue_by_destination', titleKey: 'p8RepRevenueDestination', roles: ['super_admin', 'finance'], args: (f, t) => ({ p_from: f, p_to: t }),
    columns: [['origin', 'p8ColOrigin'], ['destination', 'p8ColDestination'], ['bookings', 'p8ColBookings'], ['passengers', 'p8ColPassengers'], ['net_halala', 'p8Net', true], ['vat_halala', 'p8Vat', true], ['gross_halala', 'p8Total', true], ['refunded_halala', 'p8ColRefunded', true]] },
  { id: 'payments', fn: 'report_payments_summary', titleKey: 'p8RepPayments', roles: ['super_admin', 'finance'], args: (f, t) => ({ p_from: f, p_to: t }),
    columns: [['method', 'p8Method'], ['mode', 'p8ColMode'], ['status', 'p8ColStatus'], ['payments', 'p8ColCount'], ['amount_halala', 'p8ColAmount', true], ['refunded_halala', 'p8ColRefunded', true], ['fees_halala', 'p8ColFees', true]] },
  { id: 'reconciliation', fn: 'report_payment_reconciliation', titleKey: 'p8RepReconciliation', roles: ['super_admin', 'finance'], args: (f, t) => ({ p_from: f, p_to: t }),
    columns: [['booking_reference', 'pbReference'], ['booking_status', 'p8ColStatus'], ['payment_status', 'pbStatusPayment'], ['booking_total_halala', 'p8Total', true], ['captured_halala', 'p8ColCollected', true],
      ['refunded_halala', 'p8ColRefunded', true], ['invoice_number', 'p8ColInvoice'], ['mode', 'p8ColMode'], ['issue', 'p8ColIssue']] },
  { id: 'cancellations', fn: 'report_cancellations', titleKey: 'p8RepCancellations', roles: ['super_admin', 'finance', 'operations'], args: (f, t) => ({ p_from: f, p_to: t }),
    columns: [['booking_reference', 'pbReference'], ['account_type', 'p8ColAccount'], ['cancelled_at', 'p8ColWhen'], ['reason', 'p8Reason'], ['payment_status', 'pbStatusPayment'], ['refund_status', 'p8Refund'], ['total_halala', 'p8Total', true]] },
  { id: 'customers', fn: 'report_customer_activity', titleKey: 'p8RepCustomers', roles: ['super_admin', 'finance', 'operations'], args: (f, t) => ({ p_from: f, p_to: t }),
    columns: [['segment', 'p8ColAccount'], ['organization', 'p8ColOrganization'], ['bookings', 'p8ColBookings'], ['passengers', 'p8ColPassengers'], ['gross_halala', 'p8Total', true], ['cancellations', 'p8ColCancelled']] },
  { id: 'agents', fn: 'report_agent_activity', titleKey: 'p8RepAgents', roles: ['super_admin', 'finance'], args: (f, t) => ({ p_from: f, p_to: t }),
    columns: [['agent', 'p8ColOrganization'], ['bookings', 'p8ColBookings'], ['passengers', 'p8ColPassengers'], ['gross_halala', 'p8Total', true], ['settlements_open', 'p8ColOpenSettlements']] },
  { id: 'balances', fn: 'report_outstanding_balances', titleKey: 'p8RepBalances', roles: ['super_admin', 'finance'], args: () => ({}),
    columns: [['legal_name', 'p8ColOrganization'], ['account_type', 'p8ColAccount'], ['credit_status', 'p8ColStatus'], ['credit_limit_halala', 'p8ColLimit', true], ['outstanding_halala', 'p8ColOutstanding', true],
      ['overdue_halala', 'p8ColOverdue', true], ['available_halala', 'p8ColAvailable', true], ['open_invoices', 'p8ColOpenInvoices']] },
];

function ReportPanel({ def, from, to }: { def: ReportDef; from: string; to: string }) {
  const { t, lang } = useLanguage();
  const { data, error, reload } = useLoad(() => runReport(def.fn, def.args(from, to)), [def.id, from, to]);
  const columns: Column[] = def.columns.map(([key, label, money]) => ({ key, label: t(label), money }));
  const format = (c: Column, v: unknown) => {
    if (v === null || v === undefined || v === '') return '—';
    if (c.money) return formatSar(Number(v), lang);
    if (typeof v === 'boolean') return v ? t('p8Yes') : t('p8No');
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' });
    return String(v);
  };
  if (error) return <div className="notice danger" role="alert">{t(error)} <button type="button" className="link-btn" onClick={() => void reload()}>{t('screenErrorRetry')}</button></div>;
  if (!data) return <div className="card card-pad" role="status">{t('p4Loading')}</div>;
  return <DataTable title={t(def.titleKey)} columns={columns} rows={data} filename={`gulf-mover-${def.id}-${from}-${to}`} format={format} />;
}

export default function ReportsView() {
  const { t } = useLanguage();
  const roles = usePlatformRoles() ?? [];
  const available = REPORTS.filter(r => r.roles.some(role => roles.includes(role)));
  const [selected, setSelected] = useState('daily');
  const [from, setFrom] = useState(todayRiyadh(-30));
  const [to, setTo] = useState(todayRiyadh(30));
  const def = available.find(r => r.id === selected) ?? available[0];
  return (
    <>
      <ProdPageHeader titleKey="p8ReportsTitle" subKey="p8ReportsSub" />
      <RequireRoles roles={['super_admin', 'finance', 'operations']}>
        <section className="card card-pad">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="rep-type">{t('p8ReportType')}</label>
              <select id="rep-type" value={def?.id ?? ''} onChange={e => setSelected(e.target.value)}>
                {available.map(r => <option key={r.id} value={r.id}>{t(r.titleKey)}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="rep-from">{t('p8From')}</label><input id="rep-from" type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
            <div className="field"><label htmlFor="rep-to">{t('p8To')}</label><input id="rep-to" type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>{t('p8ReportsNote')}</p>
        </section>
        {def && from && to && from <= to && <ReportPanel key={`${def.id}-${from}-${to}`} def={def} from={from} to={to} />}
      </RequireRoles>
    </>
  );
}
