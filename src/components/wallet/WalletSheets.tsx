import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { useDemo } from '../../context/DemoContext';
import { Icon } from '../Icon';
import { WalletPassVisual } from './WalletPassVisual';
import { saudiLocalDate } from '../../domain/dates';
import type { TicketEntry } from '../../hooks/useTicketIndex';

/** Fixed sheet wrapper: Esc closes, focus lands in the sheet, ARIA dialog semantics. */
function Sheet({ onClose, label, children }: { onClose: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="wallet-layer" role="presentation">
      <div className="wallet-sheet" ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <div className="sheet-grip" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

/** "Add to Apple Wallet" → preview → Add → success → Done. One pass per ticket. */
export function WalletAddSheet({ entry, onClose }: { entry: TicketEntry; onClose: () => void }) {
  const { t } = useLanguage();
  const { addWalletPass, boats } = useDemo();
  const [state, setState] = useState<'preview' | 'added'>('preview');
  const busy = useRef(false);

  const add = () => {
    if (busy.current) return; // repeated clicks must not stack transitions
    busy.current = true;
    addWalletPass(entry.ticket.id); // dedupes internally: one saved pass per ticket
    setState('added');
    busy.current = false;
  };

  return (
    <Sheet onClose={onClose} label={t('walletAddTitle')}>
      {state === 'preview' ? (
        <>
          <div className="between">
            <h2 className="sheet-title">{t('walletAddTitle')}</h2>
            <span className="wallet-demo-tag">presentation simulation</span>
          </div>
          <p className="sheet-sub">{t('walletAddSub')}</p>
          <WalletPassVisual booking={entry.booking} leg={entry.leg} ticket={entry.ticket} legDate={entry.legDate} boats={boats} />
          <div className="notice warn" style={{ marginTop: 13 }}><strong>{t('demoOnly')}</strong>{t('walletSimNote')}</div>
          <div className="wallet-actions">
            <button type="button" className="btn btn-outline" autoFocus onClick={onClose}>{t('walletCancel')}</button>
            <button type="button" className="btn wallet-add-btn" onClick={add}>{t('walletAddAction')}</button>
          </div>
        </>
      ) : (
        <>
          <div className="pass-added">
            <div className="pass-check" aria-hidden="true"><Icon name="check" /></div>
            <h2 className="sheet-title">{t('walletAddedTitle')}</h2>
            <p className="sheet-sub">{t('walletAddedSub')}</p>
          </div>
          <div className="wallet-actions">
            <button type="button" className="btn wallet-add-btn" autoFocus onClick={onClose}>{t('passAddedDone')}</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** Saved pass view: re-renders straight from live demo state, never a stale copy. */
export function WalletPassSheet({ entry, onClose }: { entry: TicketEntry; onClose: () => void }) {
  const { t } = useLanguage();
  const { boats } = useDemo();
  return (
    <Sheet onClose={onClose} label={t('walletOpenSaved')}>
      <div className="between">
        <h2 className="sheet-title">{t('walletOpenSaved')}</h2>
        <span className="wallet-demo-tag">presentation simulation</span>
      </div>
      <div className="wallet-open">
        <WalletPassVisual booking={entry.booking} leg={entry.leg} ticket={entry.ticket} legDate={entry.legDate} boats={boats} />
      </div>
      <div className="wallet-actions">
        <button type="button" className="btn wallet-add-btn" autoFocus onClick={onClose}>{t('walletDone')}</button>
      </div>
    </Sheet>
  );
}

/** Lock-screen simulation of the iPhone side-button double-click. */
export function SideButtonDemoSheet({ entries, onClose }: { entries: TicketEntry[]; onClose: () => void }) {
  const { t, lang } = useLanguage();
  const [step, setStep] = useState<'lock' | 'run' | 'pass'>('lock');
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (step === 'pass' && !entries[0]) setStep('lock'); // saved demo data was reset
  }, [step, entries]);
  useEffect(() => {
    if (step !== 'run') return;
    timer.current = window.setTimeout(() => setStep('pass'), 950);
    return () => window.clearTimeout(timer.current);
  }, [step]);

  // Runs inside the mock iPhone, so labels come from the same language system.
  const clock = () => {
    const now = new Date();
    const t12 = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    const dayFmt = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA' : 'en-GB', { timeZone: 'Asia/Riyadh', weekday: 'long', day: 'numeric', month: 'long' });
    return { time: t12.startsWith('24') ? `00${t12.slice(2)}` : t12, day: dayFmt.format(now) };
  };
  const { time, day } = clock();
  const first = entries[0];

  if (step === 'pass' && !first) return null;
  if (step === 'pass') {
    return <WalletPassSheet entry={first!} onClose={onClose} />;
  }

  return (
    <div className="lock-layer" role="dialog" aria-modal="true" aria-label={t('walletSideBtn')}>
      <span className={`side-btn${step === 'run' ? ' pressing' : ''}`} aria-hidden="true" />
      {step === 'run' && <span className="side-tap" aria-hidden="true">double-click</span>}
      <button type="button" className="btn btn-outline btn-small lock-close" onClick={onClose}>{t('walletClose')}</button>
      <div className="lock-time" dir="ltr">{time}</div>
      <div className="lock-date">{day} · {saudiLocalDate()}</div>
      <p className="lock-hint">{t('walletLockHint')}</p>
      <div className="lock-actions">
        <button type="button" className="btn wallet-add-btn" autoFocus disabled={step === 'run' || !first} onClick={() => setStep('run')}>
          {t('walletSideStart')}
        </button>
        <button type="button" className="btn btn-outline" disabled={!first} onClick={() => setStep('pass')}>{t('walletSideDirect')}</button>
      </div>
    </div>
  );
}
