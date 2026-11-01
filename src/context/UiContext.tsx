import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLanguage } from './LanguageContext';

interface ModalOptions {
  title: string;
  desc: string;
  confirmText: string;
  /** When true the confirm button is blocked until a reason is entered. */
  requireReason: boolean;
  /** Phase 20: destructive actions get a red confirm button. Styling only. */
  danger?: boolean;
  onConfirm: (reason: string) => void;
}

interface UiContextValue {
  /** Shows a transient message; English text is translated at render time. */
  toast: (message: string) => void;
  openModal: (options: ModalOptions) => void;
}

const UiContext = createContext<UiContextValue | undefined>(undefined);

export function UiProvider({ children }: { children: ReactNode }) {
  const { t, tx } = useLanguage();
  const [toastMessage, setToastMessage] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef<number>();
  const [modal, setModal] = useState<ModalOptions | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    setToastVisible(true);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastVisible(false), 3000);
  }, []);

  const openModal = useCallback((options: ModalOptions) => {
    setReason('');
    setReasonError(false);
    setModal(options);
  }, []);

  const closeModal = useCallback(() => setModal(null), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeModal]);

  useEffect(() => {
    if (modal?.requireReason) window.setTimeout(() => reasonRef.current?.focus(), 30);
  }, [modal]);

  const confirm = () => {
    if (!modal) return;
    const trimmed = reason.trim();
    if (modal.requireReason && !trimmed) { setReasonError(true); return; }
    const { onConfirm } = modal;
    setModal(null);
    onConfirm(trimmed);
  };

  const value = useMemo(() => ({ toast, openModal }), [toast, openModal]);

  return (
    <UiContext.Provider value={value}>
      {children}
      <div className={`toast${toastVisible ? ' show' : ''}`} role="status" aria-live="polite">{tx(toastMessage)}</div>
      <div className={`modal-backdrop${modal ? ' open' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-desc" data-danger={modal?.danger ? 'true' : undefined}>
        <div className="modal">
          <h3 id="modal-title">{modal?.title ?? t('confirmAction')}</h3>
          <p id="modal-desc">{modal?.desc}</p>
          {modal?.requireReason !== false && (
            <div className="field">
              <label htmlFor="modal-reason">{t('reasonLabel')}</label>
              <textarea id="modal-reason" ref={reasonRef} placeholder={t('reasonPlaceholder')} value={reason}
                onChange={e => setReason(e.target.value)} />
              {reasonError && <div className="error">{t('reasonRequired')}</div>}
            </div>
          )}
          <div className="modal-actions">
            <button className="btn btn-outline" type="button" onClick={closeModal}>{t('cancel')}</button>
            <button className={`btn ${modal?.danger ? 'btn-danger' : 'btn-primary'}`} type="button" onClick={confirm}>{modal?.confirmText ?? t('confirm')}</button>
          </div>
        </div>
      </div>
    </UiContext.Provider>
  );
}

export function useUi(): UiContextValue {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used within a UiProvider');
  return ctx;
}
