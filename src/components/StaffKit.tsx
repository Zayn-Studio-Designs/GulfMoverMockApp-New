import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { usePlatformRoles } from '../context/OnboardingContext';
import { toCsv, downloadCsv } from '../domain/csv';
import { buildPdf, downloadBytes } from '../domain/pdf';
import { dataErrorKey } from './ProductionUi';

/** Small shared building blocks for the Phase 8 staff pages. */

export function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setError('');
    try { setData(await loader()); } catch (e) { setError(dataErrorKey(e)); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}

export type Flash = { tone: 'ok' | 'error'; key: string; extra?: string } | null;

export function FlashNotice({ flash }: { flash: Flash }) {
  const { t } = useLanguage();
  if (!flash) return null;
  return <div className={`notice ${flash.tone === 'ok' ? '' : 'danger'}`} role={flash.tone === 'ok' ? 'status' : 'alert'} style={{ marginTop: 10 }}>{t(flash.key)}{flash.extra ? ` ${flash.extra}` : ''}</div>;
}

/** Runs a staff action and reports a translated outcome; never shows raw database text. */
export function useAction(after: () => Promise<void> | void) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const run = async (fn: () => Promise<unknown>, okKey = 'p8Saved') => {
    if (busy) return;
    setBusy(true); setFlash(null);
    try { const r = await fn(); setFlash({ tone: 'ok', key: okKey, extra: typeof r === 'string' || typeof r === 'number' ? `(${r})` : undefined }); await after(); }
    catch (e) { setFlash({ tone: 'error', key: dataErrorKey(e) }); }
    finally { setBusy(false); }
  };
  return { busy, flash, run };
}

export function RequireRoles({ roles, children }: { roles: readonly string[]; children: ReactNode }) {
  const { t } = useLanguage();
  const mine = usePlatformRoles();
  if (mine === null) return <div className="card card-pad" role="status">{t('onbLoading')}</div>;
  if (!mine.some(r => roles.includes(r))) return <div className="card card-pad"><div className="notice warn" role="alert">{t('p8NotAuthorizedPage')}</div></div>;
  return <>{children}</>;
}

export interface Column { readonly key: string; readonly label: string; readonly money?: boolean }

/** Accessible table with CSV (Excel-compatible, UTF-8 BOM) and Latin PDF exports. */
export function DataTable({ title, columns, rows, filename, format }: {
  title: string; columns: readonly Column[]; rows: ReadonlyArray<Record<string, unknown>>; filename: string;
  format: (column: Column, value: unknown) => string;
}) {
  const { t } = useLanguage();
  const csvValue = (c: Column, v: unknown) => (c.money && typeof v === 'number' ? (v / 100).toFixed(2) : v ?? '');
  const exportCsv = () => downloadCsv(`${filename}.csv`, toCsv(columns.map(c => c.money ? `${c.label} (SAR)` : c.label), rows.map(r => columns.map(c => csvValue(c, r[c.key])))));
  const exportPdf = () => downloadBytes(buildPdf(title, [
    { text: `Gulf Mover - ${title}`, size: 14, bold: true },
    { text: `Generated ${new Date().toISOString()} (Asia/Riyadh dates)`, size: 8 },
    { text: columns.map(c => c.label).join(' | '), bold: true, gapBefore: 8, size: 8 },
    ...rows.map(r => ({ text: columns.map(c => String(csvValue(c, r[c.key]))).join(' | '), size: 8 })),
  ]), `${filename}.pdf`, 'application/pdf');
  return (
    <section className="card card-pad">
      <div className="between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 className="card-title">{title}</h2>
        <div className="row">
          <button type="button" className="btn btn-outline btn-small" onClick={exportCsv} disabled={rows.length === 0}>{t('p8ExportCsv')}</button>
          <button type="button" className="btn btn-outline btn-small" onClick={exportPdf} disabled={rows.length === 0}>{t('p8ExportPdf')}</button>
        </div>
      </div>
      {rows.length === 0 ? <div className="no-data" style={{ marginTop: 10 }}>{t('p8NoRows')}</div> : (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table">
            <thead><tr>{columns.map(c => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{columns.map(c => <td key={c.key}>{format(c, r[c.key])}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function todayRiyadh(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function ReasonField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const { t } = useLanguage();
  return (
    <div className="field">
      <label htmlFor={id}>{t('p8Reason')} *</label>
      <input id={id} maxLength={500} value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}
