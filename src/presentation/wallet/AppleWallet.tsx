import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { QRCodeTicket } from '../../components/QRCodeTicket';
import type { PassView } from '../walletProtocol';
import { DEMO_CARDS, type DemoCard } from './demoCards';
import { OS_TEXT, type OsLang, type OsText } from './osText';
import { prefersReducedMotion, useAutofocus, useCarousel, useEscape, useExit } from './hooks';

const ShipIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 17c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0" /><path d="M5 14l1.6-5h10.8L19 14" /><path d="M12 4v5M9 9V6h6v3" />
  </svg>
);

function Field({ label, value, mono, end }: { label: string; value: string; mono?: boolean; end?: boolean }) {
  return (
    <div className={`ap-field${end ? ' ap-end' : ''}`}>
      <span className="ap-label">{label}</span>
      <span className={`ap-value${mono ? ' ap-mono' : ''}`}>{value}</span>
    </div>
  );
}

/** Boarding-pass style Gulf Mover pass. `full` adds the secondary fields and the ticket's own QR code. */
export function ApplePass({ pass, text, full }: { pass: PassView; text: OsText; full?: boolean }) {
  return (
    <article className={`ap${full ? ' ap-full' : ''}`} data-ticket={pass.ticketId}>
      <div className="ap-head">
        <span className="ap-logo" aria-hidden="true">GM</span>
        <span className="ap-org">GULF MOVER</span>
        <Field label={text.departs} value={pass.time} end />
      </div>
      <div className="ap-primary">
        <Field label={text.from} value={pass.from} />
        <span className="ap-ship"><ShipIcon /></span>
        <Field label={text.to} value={pass.to} end />
      </div>
      {full && (
        <>
          <div className="ap-row">
            <Field label={text.date} value={pass.date} />
            <Field label={text.passenger} value={pass.passenger} />
            <Field label={text.journey} value={pass.legLabel} end />
          </div>
          <div className="ap-row">
            <Field label={text.booking} value={pass.ref} mono />
            {pass.boat && <Field label={text.boat} value={pass.boat} />}
            <div className="ap-field ap-end">
              <span className="ap-label">{text.status}</span>
              <span className={`ap-chip is-${pass.statusKind}`}>{pass.statusLabel}</span>
            </div>
          </div>
          <div className="ap-barcode">
            <QRCodeTicket ticketId={pass.ticketId} size={150} />
          </div>
        </>
      )}
    </article>
  );
}

/** Network mark drawn for the fictional demo cards (no real brand artwork). */
function NetworkMark({ card }: { card: DemoCard }) {
  if (card.network === 'mastercard') {
    return <span className="cc-mc" aria-hidden="true"><i /><i /></span>;
  }
  if (card.network === 'visa') return <span className="cc-visa" aria-hidden="true">VISA</span>;
  return <span className="cc-charge" aria-hidden="true">GOLD</span>;
}

/** Payment card face in the Apple Wallet style: credit-card proportions, art, chip, masked number. */
function AppleCardFace({ card }: { card: DemoCard }) {
  return (
    <div className={`cc cc-${card.art}`} dir="ltr">
      <div className="cc-top">
        <span className="cc-issuer">{card.issuer}</span>
        <span className="cc-demo">DEMO</span>
      </div>
      <span className="cc-chip" aria-hidden="true" />
      <div className="cc-bottom">
        <span className="cc-number">{card.masked}</span>
        <NetworkMark card={card} />
      </div>
    </div>
  );
}

type Item = { kind: 'card'; id: string; card: DemoCard } | { kind: 'pass'; id: string; pass: PassView };

const itemLabel = (item: Item) => (item.kind === 'card'
  ? `${item.card.issuer} ${item.card.product}, •••• ${item.card.last4}`
  : `${item.pass.from} → ${item.pass.to} · ${item.pass.date} ${item.pass.time} · ${item.pass.legLabel}`);

/** Details under the open card: payment card facts, or the pass information. */
function ItemDetails({ item, text }: { item: Item; text: OsText }) {
  if (item.kind === 'pass') {
    const p = item.pass;
    return (
      <div className="aw-panel">
        <h3 className="aw-panel-title">{text.passInfo}</h3>
        <dl className="aw-list">
          <div><dt>{text.ticket}</dt><dd className="ap-mono">{p.ticketId}</dd></div>
          <div><dt>{text.booking}</dt><dd className="ap-mono">{p.ref}</dd></div>
          <div><dt>{text.journey}</dt><dd>{p.legLabel}</dd></div>
        </dl>
        <p className="aw-panel-note">{text.scanHint}</p>
      </div>
    );
  }
  const c = item.card;
  return (
    <div className="aw-panel">
      <p className="aw-reader"><span className="aw-reader-icon" aria-hidden="true" />{text.holdNearReader}</p>
      <h3 className="aw-panel-title">{text.cardDetails}</h3>
      <dl className="aw-list">
        <div><dt>{text.cardNumber}</dt><dd className="ap-mono">•••• {c.last4}</dd></div>
        <div><dt>{text.cardholder}</dt><dd>{c.holder}</dd></div>
        <div><dt>{text.expires}</dt><dd className="ap-mono">{c.expiry}</dd></div>
      </dl>
      <h3 className="aw-panel-title">{text.latest}</h3>
      <p className="aw-panel-note">{text.noTransactions}</p>
      <p className="aw-panel-note">{text.demoCardNote}</p>
    </div>
  );
}

/**
 * Simulated Wallet app on the mock iPhone. Home is the familiar black screen with every card
 * stacked (payment cards, then the Gulf Mover passes); tapping a card opens it, and from there
 * the cards can be swiped through. `closeSignal` lets the side button put Wallet away.
 */
export function AppleWallet({ lang, passes, focusTicketId, closeSignal, onClosed }: {
  lang: OsLang;
  passes: PassView[];
  focusTicketId?: string;
  closeSignal: number;
  onClosed: () => void;
}) {
  const text = OS_TEXT[lang];
  const items: Item[] = [
    ...DEMO_CARDS.map(card => ({ kind: 'card' as const, id: card.id, card })),
    ...passes.map(pass => ({ kind: 'pass' as const, id: pass.ticketId, pass })),
  ];
  const focusIndex = focusTicketId ? items.findIndex(i => i.id === focusTicketId) : -1;
  const [open, setOpen] = useState(focusIndex >= 0);
  const carousel = useCarousel(items.length, Math.max(focusIndex, 0));
  const { closing, close } = useExit(onClosed, 300);
  const ref = useAutofocus(open ? `card-${carousel.index}` : 'stack');
  const active = items[carousel.index];

  // Only presses made while this Wallet is open count, not the one that closed the last one.
  const openedAtSignal = useRef(closeSignal);
  useEffect(() => { if (closeSignal !== openedAtSignal.current) close(); }, [closeSignal, close]);
  useEscape(() => (open ? setOpen(false) : close()));

  const openItem = (i: number) => { carousel.go(i); setOpen(true); };
  const trackStyle = {
    '--i': carousel.index,
    '--drag': `${carousel.drag}px`,
    transition: carousel.dragging || prefersReducedMotion() ? 'none' : undefined,
  } as CSSProperties;

  return (
    <div className={`aw${closing ? ' is-closing' : ''}`} role="dialog" aria-modal="true" aria-label={text.appleWalletLabel}
      dir={lang === 'ar' ? 'rtl' : 'ltr'} ref={ref}>
      {open && active ? (
        <div className="aw-cardview">
          <div className="aw-bar">
            <span className="aw-bar-count" aria-live="polite">{text.cardOf.replace('{n}', String(carousel.index + 1)).replace('{total}', String(items.length))}</span>
            <button type="button" className="aw-link aw-strong" data-autofocus onClick={() => setOpen(false)}>{text.done}</button>
          </div>
          <div className="aw-carousel" role="group" aria-roledescription="carousel" aria-label={text.cards} tabIndex={0}
            onKeyDown={carousel.onKeyDown} {...carousel.handlers}>
            <div className="aw-track" dir="ltr" style={trackStyle}>
              {items.map((item, i) => (
                <div key={item.id} className={`aw-slide${i === carousel.index ? ' is-active' : ''}`}
                  aria-hidden={i !== carousel.index} aria-label={itemLabel(item)} role="group" aria-roledescription="slide"
                  onClick={() => carousel.go(i)}>
                  <div dir={lang === 'ar' ? 'rtl' : 'ltr'}>
                    {item.kind === 'card' ? <AppleCardFace card={item.card} /> : <ApplePass pass={item.pass} text={text} full />}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="aw-dots" role="group" aria-label={text.swipeHint}>
            {items.map((item, i) => (
              <button key={item.id} type="button" className={`aw-dot${i === carousel.index ? ' is-active' : ''}${item.kind === 'pass' ? ' is-pass' : ''}`}
                aria-label={`${text.cardOf.replace('{n}', String(i + 1)).replace('{total}', String(items.length))}: ${itemLabel(item)}`}
                aria-current={i === carousel.index} onClick={() => carousel.go(i)} />
            ))}
          </div>
          <ItemDetails item={active} text={text} key={active.id} />
        </div>
      ) : (
        <div className="aw-home">
          <div className="aw-header">
            <h2 className="aw-title">{text.wallet}</h2>
            <span className="aw-header-actions" aria-hidden="true"><span className="aw-round">+</span><span className="aw-round">•••</span></span>
          </div>
          <span className="aw-badge">{text.simBadge}</span>
          <ul className="aw-stack">
            {items.map((item, i) => (
              <li key={item.id} className={`aw-slot${item.kind === 'pass' && (i === 0 || items[i - 1].kind !== 'pass') ? ' is-first-pass' : ''}`}
                style={{ zIndex: i + 1, '--n': i } as CSSProperties}>
                <button type="button" className="aw-card" data-autofocus={i === items.length - 1 ? '' : undefined}
                  aria-label={itemLabel(item)} onClick={() => openItem(i)}>
                  {item.kind === 'card' ? <AppleCardFace card={item.card} /> : <ApplePass pass={item.pass} text={text} />}
                </button>
              </li>
            ))}
          </ul>
          {passes.length === 0 && <p className="aw-empty">{text.emptyApple}</p>}
          <p className="aw-note">{text.simNote}</p>
        </div>
      )}
      <button type="button" className="os-home-indicator" aria-label={text.backToApp} onClick={close} />
    </div>
  );
}

/**
 * The system "Add pass" sheet the app hands over to: Cancel / Add with the pass preview. Add
 * drops the pass into Wallet and shows the green "Added to Apple Wallet" confirmation before the
 * sheet goes; a pass that is already saved offers View instead of a second Add.
 */
export function AppleAddSheet({ lang, pass, alreadySaved, onAdd, onAdded, onView, onClosed }: {
  lang: OsLang;
  pass: PassView;
  alreadySaved: boolean;
  onAdd: () => void;
  onAdded: () => void;
  onView: () => void;
  onClosed: () => void;
}) {
  const text = OS_TEXT[lang];
  const [phase, setPhase] = useState<'preview' | 'adding' | 'added'>('preview');
  // What to do once the sheet has gone (open Wallet, show guidance). A ref, not state: the close
  // timer must see it even if React has not re-rendered yet.
  const after = useRef<(() => void) | null>(null);
  const { closing, close } = useExit(() => { onClosed(); after.current?.(); }, 280);
  const ref = useAutofocus(phase);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);
  useEscape(() => { if (phase === 'preview') close(); });
  const finish = (action: () => void) => { after.current = action; close(); };

  const add = () => {
    if (phase !== 'preview') return; // repeated taps never add twice
    onAdd();
    const quick = prefersReducedMotion();
    setPhase('adding');
    timers.current.push(window.setTimeout(() => setPhase('added'), quick ? 0 : 520));
    timers.current.push(window.setTimeout(() => finish(onAdded), quick ? 1200 : 1900));
  };

  return (
    <div className={`as-layer${closing ? ' is-closing' : ''}`} dir={lang === 'ar' ? 'rtl' : 'ltr'} ref={ref}>
      <div className={`as-sheet is-${phase}`} role="dialog" aria-modal="true" aria-label={text.appleWalletLabel}>
        <div className="as-bar">
          <button type="button" className="aw-link" data-autofocus={phase === 'preview' ? '' : undefined} disabled={phase !== 'preview'} onClick={close}>{text.cancel}</button>
          {alreadySaved
            ? <button type="button" className="aw-link aw-strong" onClick={() => finish(onView)}>{text.view}</button>
            : <button type="button" className="aw-link aw-strong" disabled={phase !== 'preview'} onClick={add}>{text.add}</button>}
        </div>
        {alreadySaved && <p className="as-note" role="status">{text.alreadyAdded}</p>}
        <div className="as-pass"><ApplePass pass={pass} text={text} full /></div>
        <p className="aw-note">{text.simNote}</p>
      </div>
      {phase === 'added' && (
        <div className="as-hud" role="status" tabIndex={-1} data-autofocus>
          <svg className="as-check" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24" /><path d="M15 27l7 7 15-16" /></svg>
          <span>{text.addedApple}</span>
        </div>
      )}
    </div>
  );
}
