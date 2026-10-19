import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import type { WorkMode } from '../context/WorkModeContext';
import { ArrowIcon } from './Icon';

/**
 * One stop on the guided tour. `target` lists one or more names (space-separated) matched against
 * elements marked `data-tour="…"`; all visible matches are highlighted together. `route` opens the
 * page the step talks about. A step whose target is missing or hidden (for example the sidebar
 * view switch on phones) shows its card in the centre instead, so the tour never gets stuck.
 */
interface TourStep { target?: string; route?: string; title: string; body: string }

/** Customer tour: home, booking, bookings, account and language. Never points at staff pages. */
const CUSTOMER_STEPS: ReadonlyArray<TourStep> = [
  { title: 'tourWelcomeTitle', body: 'tourWelcomeBody' },
  { target: 'home-book', route: '/', title: 'tourHomeTitle', body: 'tourHomeBody' },
  { target: 'booking-services', route: '/book', title: 'tourServiceTitle', body: 'tourServiceBody' },
  { target: 'booking-steps', route: '/book', title: 'tourStepsTitle', body: 'tourStepsBody' },
  { target: 'nav-navBookings', route: '/bookings', title: 'tourBookingsTitle', body: 'tourBookingsBody' },
  { target: 'booking-card', route: '/bookings', title: 'tourCardTitle', body: 'tourCardBody' },
  { target: 'account', route: '/settings', title: 'tourAccountTitle', body: 'tourAccountBody' },
  { target: 'language', title: 'tourLangTitle', body: 'tourLangBody' },
  { target: 'home-book', route: '/', title: 'tourDoneTitle', body: 'tourDoneBody' },
];

/** ATCO staff tour: the demo view switch, then each management destination on its own page. */
const STAFF_STEPS: ReadonlyArray<TourStep> = [
  { title: 'tourStaffWelcomeTitle', body: 'tourStaffWelcomeBody' },
  { target: 'ws-switch', title: 'tourSwitchTitle', body: 'tourSwitchBody' },
  { target: 'nav-navOps', route: '/operations', title: 'tourOpsTitle', body: 'tourOpsBody' },
  { target: 'nav-navBoarding', route: '/boarding', title: 'tourBoardingTitle', body: 'tourBoardingBody' },
  { target: 'nav-navMaterials', route: '/materials', title: 'tourMaterialsTitle', body: 'tourMaterialsBody' },
  { target: 'nav-navFleet', route: '/fleet', title: 'tourFleetTitle', body: 'tourFleetBody' },
  { target: 'nav-navCorporate', route: '/corporate', title: 'tourCorporateTitle', body: 'tourCorporateBody' },
  { target: 'account', title: 'tourAccountTitle', body: 'tourStaffAccountBody' },
  { title: 'tourDoneTitle', body: 'tourStaffDoneBody' },
];

export const TOUR_STEPS: Record<WorkMode, ReadonlyArray<TourStep>> = { customer: CUSTOMER_STEPS, staff: STAFF_STEPS };

// Which demo accounts have already been shown the tour (this browser only).
const SEEN_KEY = 'gm-demo-tour-seen';

function seenIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export const hasSeenTour = (userId: string) => seenIds().includes(userId);

export function markTourSeen(userId: string) {
  try {
    if (!hasSeenTour(userId)) localStorage.setItem(SEEN_KEY, JSON.stringify([...seenIds(), userId]));
  } catch {
    // Storage unavailable (private mode): the tour may show again next time.
  }
}

const GAP = 14;
const GUTTER = 16;
const PAD = 6;
// Space taken by the sticky header (top) and the phone bottom navigation (bottom).
const SAFE_TOP = 120;
const SAFE_BOTTOM = 96;

interface Box { top: number; left: number; width: number; height: number }

const findTargets = (names?: string) => (names
  ? names.split(' ').flatMap(name => [...document.querySelectorAll<HTMLElement>(`[data-tour~="${name}"]`)])
    .filter(el => el.getClientRects().length > 0)
  : []);

function unionBox(els: HTMLElement[]): Box | null {
  if (!els.length) return null;
  const rects = els.map(el => el.getBoundingClientRect());
  const top = Math.min(...rects.map(r => r.top));
  const left = Math.min(...rects.map(r => r.left));
  const bottom = Math.max(...rects.map(r => r.bottom));
  const right = Math.max(...rects.map(r => r.right));
  return { top: top - PAD, left: left - PAD, width: right - left + PAD * 2, height: bottom - top + PAD * 2 };
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

/** Beside narrow targets (sidebar links) on wide screens; otherwise below, or above when there is no room. */
function placeCard(box: Box | null, cardW: number, cardH: number, rtl: boolean): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!box) return { top: Math.max(GUTTER, (vh - cardH) / 2), left: Math.max(GUTTER, (vw - cardW) / 2) };
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  const roomBeside = rtl ? box.left : vw - right;
  if (vw > 780 && box.width < vw / 3 && roomBeside >= cardW + GAP + GUTTER) {
    return { top: clamp(box.top + box.height / 2 - cardH / 2, GUTTER, vh - cardH - GUTTER), left: rtl ? box.left - GAP - cardW : right + GAP };
  }
  const below = vh - bottom >= cardH + GAP + GUTTER || vh - bottom > box.top;
  return {
    top: clamp(below ? bottom + GAP : box.top - GAP - cardH, GUTTER, vh - cardH - GUTTER),
    left: clamp(box.left + box.width / 2 - cardW / 2, GUTTER, vw - cardW - GUTTER),
  };
}

/** Dims everything except the highlighted part, which stays usable (e.g. the language switch). */
function Blockers({ box }: { box: Box | null }) {
  if (!box) return <div className="tour-blocker" style={{ inset: 0 }} />;
  const bottom = box.top + box.height;
  const right = box.left + box.width;
  return (
    <>
      <div className="tour-blocker" style={{ top: 0, left: 0, right: 0, height: Math.max(0, box.top) }} />
      <div className="tour-blocker" style={{ top: bottom, left: 0, right: 0, bottom: 0 }} />
      <div className="tour-blocker" style={{ top: box.top, left: 0, width: Math.max(0, box.left), height: box.height }} />
      <div className="tour-blocker" style={{ top: box.top, left: right, right: 0, height: box.height }} />
    </>
  );
}

/**
 * Step-by-step guided tour for the current demo view: spotlights one part of the real interface,
 * opening the right page first, and explains it in a short card.
 */
export function Tour({ mode, onClose }: { mode: WorkMode; onClose: () => void }) {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const steps = TOUR_STEPS[mode];
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [cardSize, setCardSize] = useState({ w: 360, h: 220 });
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const step = steps[index];
  const last = index === steps.length - 1;

  // Open the page this step talks about when the step starts. Afterwards the user may follow the
  // highlighted control (e.g. tap "Book a marine transfer") without being sent back.
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  useEffect(() => {
    if (step.route && pathRef.current !== step.route) navigate(step.route);
  }, [index, step.route, navigate]);

  // Keep the spotlight on the target while the page loads, scrolls, resizes or changes language
  // (one measurement per frame; re-renders only when something moved). When the target appears it
  // is brought clear of the sticky header and the phone navigation bar.
  useEffect(() => {
    primaryRef.current?.focus({ preventScroll: true });
    let frame = 0;
    let prev = '';
    let settleFrames = 0;
    let lastTop: number | null = null;
    const tick = () => {
      const els = findTargets(step.target);
      // Jump straight there instead of drifting: the page uses smooth scrolling and smooth-scrolls
      // to the top on every page change. For the first few frames, any movement of the target
      // (such a smooth scroll starting) is cancelled with an instant scroll.
      if (els.length && settleFrames < 12) {
        settleFrames += 1;
        const r = els[0].getBoundingClientRect();
        if (lastTop === null || r.top !== lastTop) {
          if (r.top < SAFE_TOP || r.bottom > window.innerHeight - SAFE_BOTTOM) els[0].scrollIntoView?.({ block: 'center', behavior: 'instant' });
          else window.scrollTo?.({ top: window.scrollY, behavior: 'instant' });
        }
        lastTop = els[0].getBoundingClientRect().top;
      }
      const next = unionBox(els);
      const card = cardRef.current;
      const size = card && card.offsetWidth ? { w: card.offsetWidth, h: card.offsetHeight } : null;
      const key = JSON.stringify([next, size]);
      if (key !== prev) {
        prev = key;
        setBox(next);
        if (size) setCardSize(size);
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [index, step.target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const progress = t('tourProgress').replace('{n}', String(index + 1)).replace('{total}', String(steps.length));

  return (
    <div className="tour">
      <Blockers box={box} />
      <div className={`tour-spot${box ? '' : ' tour-spot-none'}`} style={box ?? undefined} aria-hidden="true" />
      <div className="tour-card" ref={cardRef} role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body"
        style={placeCard(box, cardSize.w, cardSize.h, lang === 'ar')}>
        <div className="tour-progress">{progress}</div>
        <h2 id="tour-title" className="tour-title">{t(step.title)}</h2>
        <p id="tour-body" className="tour-body">{t(step.body)}</p>
        <div className="tour-dots" aria-hidden="true">
          {steps.map((_, i) => <span key={i} className={i === index ? 'active' : ''} />)}
        </div>
        <div className="tour-actions">
          {!last && <button type="button" className="link-btn tour-skip" onClick={onClose}>{t('tourSkip')}</button>}
          <span className="tour-spacer" />
          {index > 0 && <button type="button" className="btn btn-outline" onClick={() => setIndex(i => i - 1)}>{t('back')}</button>}
          <button ref={primaryRef} type="button" className="btn btn-primary" onClick={() => (last ? onClose() : setIndex(i => i + 1))}>
            {last ? t('tourFinish') : <>{t('tourNext')} <ArrowIcon /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
