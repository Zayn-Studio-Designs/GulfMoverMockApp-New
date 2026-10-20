import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { QRCodeTicket } from '../../components/QRCodeTicket';
import type { PassView } from '../walletProtocol';
import { DEMO_CARDS, type DemoCard } from './demoCards';
import { OS_TEXT, type OsLang, type OsText } from './osText';
import { prefersReducedMotion, useAutofocus, useCarousel, useEscape, useExit } from './hooks';

const BackArrow = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" className="gw-flip"><path fill="currentColor" d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z" /></svg>
);
const Contactless = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8.5 8.5a5 5 0 0 1 0 7M12 6a8.5 8.5 0 0 1 0 12M15.5 3.5a12 12 0 0 1 0 17" /></svg>
);

/** Compact pass row, as in the Passes list. */
function GooglePassTile({ pass, text }: { pass: PassView; text: OsText }) {
  return (
    <span className="gp-tile">
      <span className="gp-logo" aria-hidden="true">GM</span>
      <span className="gp-tile-text">
        <span className="gp-tile-title">Gulf Mover · {text.marineTransfer}</span>
        <span className="gp-tile-sub">{pass.from} → {pass.to}</span>
        <span className="gp-tile-sub">{pass.date} · {pass.time} · {pass.legLabel}</span>
      </span>
    </span>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="gp-row">
      <span className="gp-label">{label}</span>
      <span className={`gp-value${mono ? ' gp-mono' : ''}`}>{value}</span>
    </div>
  );
}

/** Full Google-style pass: coloured header card, details and the ticket's own QR code. */
export function GooglePass({ pass, text }: { pass: PassView; text: OsText }) {
  return (
    <article className="gp" data-ticket={pass.ticketId}>
      <div className="gp-card">
        <div className="gp-issuer"><span className="gp-logo" aria-hidden="true">GM</span><span>Gulf Mover</span></div>
        <div className="gp-route">
          <span>{pass.from}</span>
          <span className="gp-route-arrow" aria-hidden="true">→</span>
          <span>{pass.to}</span>
        </div>
        <div className="gp-grid">
          <Row label={text.date} value={pass.date} />
          <Row label={text.departs} value={pass.time} />
          <Row label={text.passenger} value={pass.passenger} />
          <Row label={text.journey} value={pass.legLabel} />
        </div>
        <div className="gp-qr">
          <QRCodeTicket ticketId={pass.ticketId} size={168} />
          <span className="gp-scan">{text.scanHint}</span>
        </div>
      </div>
      <div className="gp-details">
        <Row label={text.booking} value={pass.ref} mono />
        {pass.boat && <Row label={text.boat} value={pass.boat} />}
        <Row label={text.status} value={pass.statusLabel} />
        <Row label={text.ticket} value={pass.ticketId} mono />
      </div>
    </article>
  );
}

/** Google-style payment card: flat Material art, issuer top-left, network bottom-right. */
function GoogleCardFace({ card }: { card: DemoCard }) {
  return (
    <div className={`gc gc-${card.art}`} dir="ltr">
      <div className="gc-top"><span>{card.issuer}</span><span className="gc-demo">DEMO</span></div>
      <div className="gc-bottom">
        <span className="gc-last4">•••• {card.last4}</span>
        {card.network === 'mastercard'
          ? <span className="cc-mc" aria-hidden="true"><i /><i /></span>
          : <span className={card.network === 'visa' ? 'cc-visa' : 'cc-charge'} aria-hidden="true">{card.network === 'visa' ? 'VISA' : 'GOLD'}</span>}
      </div>
    </div>
  );
}

/** The Gulf Mover pass as a card in the carousel (transit-pass look). */
function GooglePassCardFace({ pass, text }: { pass: PassView; text: OsText }) {
  return (
    <div className="gc gc-pass">
      <div className="gc-top"><span className="gc-pass-issuer"><span className="gp-logo" aria-hidden="true">GM</span>Gulf Mover</span><span>{text.boardingPass}</span></div>
      <div className="gc-pass-route">{pass.from} → {pass.to}</div>
      <div className="gc-bottom"><span>{pass.date} · {pass.time}</span><span>{pass.legLabel}</span></div>
    </div>
  );
}

type Item = { kind: 'card'; id: string; card: DemoCard } | { kind: 'pass'; id: string; pass: PassView };
const itemLabel = (item: Item) => (item.kind === 'card'
  ? `${item.card.issuer} ${item.card.product}, •••• ${item.card.last4}`
  : `${item.pass.from} → ${item.pass.to} · ${item.pass.date} ${item.pass.time} · ${item.pass.legLabel}`);

/** Simulated Google Wallet on the mock Android: card carousel and Passes list → pass details. */
export function GoogleWallet({ lang, passes, focusTicketId, onClosed }: {
  lang: OsLang;
  passes: PassView[];
  focusTicketId?: string;
  onClosed: () => void;
}) {
  const text = OS_TEXT[lang];
  const items: Item[] = [
    ...DEMO_CARDS.map(card => ({ kind: 'card' as const, id: card.id, card })),
    ...passes.map(pass => ({ kind: 'pass' as const, id: pass.ticketId, pass })),
  ];
  const [selected, setSelected] = useState<string | null>(focusTicketId ?? null);
  // The newest pass is shown first after opening, so it is easy to find.
  const carousel = useCarousel(items.length, passes.length ? items.length - 1 : 0);
  const { closing, close } = useExit(onClosed, 220);
  const pass = passes.find(p => p.ticketId === selected);
  const ref = useAutofocus(pass ? pass.ticketId : 'home');
  const active = items[carousel.index];
  useEscape(() => (pass ? setSelected(null) : close()));
  const trackStyle = {
    '--i': carousel.index,
    '--drag': `${carousel.drag}px`,
    transition: carousel.dragging || prefersReducedMotion() ? 'none' : undefined,
  } as CSSProperties;

  return (
    <div className={`gw${closing ? ' is-closing' : ''}`} role="dialog" aria-modal="true" aria-label={text.googleWalletLabel}
      dir={lang === 'ar' ? 'rtl' : 'ltr'} ref={ref}>
      {pass ? (
        <div className="gw-page gw-detail" key={pass.ticketId}>
          <div className="gw-appbar">
            <button type="button" className="gw-icon-btn" data-autofocus aria-label={text.backToPasses} onClick={() => setSelected(null)}><BackArrow /></button>
            <h2 className="gw-appbar-title">{text.passDetails}</h2>
          </div>
          <GooglePass pass={pass} text={text} />
          <p className="gw-note">{text.simNote}</p>
        </div>
      ) : (
        <div className="gw-page gw-home">
          <div className="gw-appbar">
            <button type="button" className="gw-icon-btn" aria-label={text.backToApp} onClick={close}><BackArrow /></button>
            <h2 className="gw-appbar-title">{text.googleWallet}</h2>
            <span className="gw-avatar" aria-hidden="true">N</span>
          </div>
          <span className="gw-badge">{text.simBadge}</span>
          <div className="gw-carousel" role="group" aria-roledescription="carousel" aria-label={text.cards} tabIndex={0}
            onKeyDown={carousel.onKeyDown} {...carousel.handlers}>
            <div className="gw-track" dir="ltr" style={trackStyle}>
              {items.map((item, i) => (
                <div key={item.id} className={`gw-slide${i === carousel.index ? ' is-active' : ''}`} role="group" aria-roledescription="slide"
                  aria-label={itemLabel(item)} aria-hidden={i !== carousel.index}
                  onClick={() => (i === carousel.index ? (item.kind === 'pass' && setSelected(item.id)) : carousel.go(i))}>
                  <div dir={lang === 'ar' ? 'rtl' : 'ltr'}>
                    {item.kind === 'card' ? <GoogleCardFace card={item.card} /> : <GooglePassCardFace pass={item.pass} text={text} />}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="gw-dots" role="group" aria-label={text.swipeHint}>
            {items.map((item, i) => (
              <button key={item.id} type="button" className={`gw-dot${i === carousel.index ? ' is-active' : ''}`}
                aria-label={`${text.cardOf.replace('{n}', String(i + 1)).replace('{total}', String(items.length))}: ${itemLabel(item)}`}
                aria-current={i === carousel.index} onClick={() => carousel.go(i)} />
            ))}
          </div>
          {active && (active.kind === 'card' ? (
            <div className="gw-context" key={active.id}>
              <span className="gw-chip"><Contactless />{text.holdToReader}</span>
              <p className="gw-note gw-note-start">{active.card.issuer} {active.card.product} · {text.demoCardNote}</p>
            </div>
          ) : (
            <div className="gw-context" key={active.id}>
              <button type="button" className="gs-filled-btn" data-autofocus onClick={() => setSelected(active.id)}>{text.viewPass}</button>
            </div>
          ))}
          <h3 className="gw-section">{text.passes}</h3>
          {passes.length === 0 ? (
            <p className="gw-empty">{text.emptyGoogle}</p>
          ) : (
            <ul className="gw-passes">
              {passes.map(p => (
                <li key={p.ticketId}>
                  <button type="button" className="gw-tile-btn" onClick={() => setSelected(p.ticketId)}>
                    <GooglePassTile pass={p} text={text} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="gw-note">{text.simNote}</p>
        </div>
      )}
      <button type="button" className="os-gesture-bar" aria-label={text.backToApp} onClick={close} />
    </div>
  );
}

/** Material bottom sheet the app hands over to: Save → saving → "Added to Google Wallet" (View / Done). */
export function GoogleSaveSheet({ lang, pass, alreadySaved, onSave, onView, onClosed }: {
  lang: OsLang;
  pass: PassView;
  alreadySaved: boolean;
  onSave: () => void;
  onView: () => void;
  onClosed: (saved: boolean) => void;
}) {
  const text = OS_TEXT[lang];
  const [phase, setPhase] = useState<'ask' | 'saving' | 'saved'>(alreadySaved ? 'saved' : 'ask');
  // Refs, not state: the close timer must see them even if React has not re-rendered yet.
  const after = useRef<(() => void) | null>(null);
  const savedNow = useRef(false);
  const { closing, close } = useExit(() => { onClosed(savedNow.current); after.current?.(); }, 220);
  const ref = useAutofocus(phase);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEscape(() => { if (phase !== 'saving') close(); });
  const finish = (action: () => void) => { after.current = action; close(); };
  const save = () => {
    if (phase !== 'ask') return; // repeated taps never save twice
    onSave();
    savedNow.current = true;
    setPhase('saving');
    timer.current = window.setTimeout(() => setPhase('saved'), prefersReducedMotion() ? 0 : 650);
  };

  return (
    <div className={`gs-layer${closing ? ' is-closing' : ''}`} dir={lang === 'ar' ? 'rtl' : 'ltr'} ref={ref}>
      <button type="button" className="gs-scrim" aria-label={text.cancel} tabIndex={-1} onClick={() => phase !== 'saving' && close()} />
      <div className="gs-sheet" role="dialog" aria-modal="true" aria-label={text.googleWalletLabel}>
        <span className="gs-handle" aria-hidden="true" />
        <span className="gs-brand">{text.googleWallet}</span>
        {phase === 'saved' ? (
          <div className="gs-done" role="status">
            <svg className="gs-check" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24" /><path d="M15 27l7 7 15-16" /></svg>
            <h2 className="gs-title">{alreadySaved ? text.alreadySaved : text.saved}</h2>
          </div>
        ) : (
          <h2 className="gs-title">{text.savePrompt}</h2>
        )}
        <div className="gs-preview"><GooglePassTile pass={pass} text={text} /></div>
        <div className="gs-actions">
          {phase === 'saved' ? (
            <>
              <button type="button" className="gs-text-btn" onClick={close}>{text.done}</button>
              <button type="button" className="gs-filled-btn" data-autofocus onClick={() => finish(onView)}>{text.view}</button>
            </>
          ) : (
            <>
              <button type="button" className="gs-text-btn" disabled={phase === 'saving'} onClick={close}>{text.cancel}</button>
              <button type="button" className="gs-filled-btn" data-autofocus disabled={phase === 'saving'} onClick={save}>
                {phase === 'saving' ? <><span className="gs-spinner" aria-hidden="true" />{text.saving}</> : text.save}
              </button>
            </>
          )}
        </div>
        <p className="gw-note">{text.simNote}</p>
      </div>
    </div>
  );
}

/** Android Quick Settings shade (pulled down from the status bar) with a working Wallet tile. */
export function QuickSettings({ lang, onWallet, onClosed }: { lang: OsLang; onWallet: () => void; onClosed: () => void }) {
  const text = OS_TEXT[lang];
  const after = useRef<(() => void) | null>(null);
  const { closing, close } = useExit(() => { onClosed(); after.current?.(); }, 200);
  const ref = useAutofocus('qs');
  useEscape(close);

  return (
    <div className={`qs-layer${closing ? ' is-closing' : ''}`} dir={lang === 'ar' ? 'rtl' : 'ltr'} ref={ref}>
      <div className="qs-shade" role="dialog" aria-modal="true" aria-label={text.quickSettings}>
        <div className="qs-tiles">
          <span className="qs-tile is-on" aria-hidden="true">{text.internet}</span>
          <span className="qs-tile is-on" aria-hidden="true">{text.bluetooth}</span>
          <span className="qs-tile" aria-hidden="true">{text.flashlight}</span>
          <button type="button" className="qs-tile qs-wallet" data-autofocus onClick={() => { after.current = onWallet; close(); }}>
            {text.googleWallet}
          </button>
        </div>
        <button type="button" className="qs-handle" aria-label={text.closeQuickSettings} onClick={close} />
      </div>
      <button type="button" className="qs-scrim" aria-label={text.closeQuickSettings} tabIndex={-1} onClick={close} />
    </div>
  );
}
