import { useEffect, useRef, useState } from 'react';

/**
 * Premium boot sequence for the simulated device (rendered by the presentation shell on top of
 * the hosted app). Visible work: reveal the authentic ATCO Marine logo, sweep a thin circular
 * progress arc, then cross-fade into the already-running app. The app is not reloaded and the
 * session, navigation, language and demo state are untouched.
 *
 * Progress is a deterministic simulated timeline — it deliberately does not imply real server
 * activity, and the caption on screen says so. The arc stays thin, timings are fixed, and the
 * sequence hands over as soon as it reaches 100% (no artificial delay when the app is ready).
 */

interface BootCopy {
  caption: string;
  ready: string;
  simNote: string;
}

const EN: BootCopy = {
  caption: 'Preparing your voyage',
  ready: 'Welcome aboard',
  simNote: 'Simulated start-up · demo presentation',
};

const AR: BootCopy = {
  caption: 'نُهيّئ رحلتك',
  ready: 'أهلاً بكم على متن الرحلة',
  simNote: 'بدء تشغيل محاكى · عرض تجريبي',
};

export function bootCopy(lang: 'en' | 'ar'): BootCopy {
  return lang === 'ar' ? AR : EN;
}

/**
 * Boot timeline in milliseconds from animation start (absolute points, kept public so replay
 * behaves identically every time). Deliberate structure:
 *  - the ship-horn and the circular progress begin together at the very start;
 *  - the horn plays once, at its natural speed (~2.0s recording), NOT stretched — the visual
 *    continues calmly after it ends (an ease-out keeps the last third alive, not a dead pause);
 *  - the whole visible sequence is exactly twice the original 2.44s boot (~4.88s).
 */
export const BOOT_TIMELINE = {
  /** Logo begins fading in. */
  logoIn: 120,
  /** The ship-horn fires together with the visual progress — one unified start. */
  hornAt: 120,
  /** Arc and percentage begin advancing (same beat as the horn). */
  progressIn: 120,
  /** Progress reaches 100% and handover begins (1980 + 460 doubled from the original boot). */
  progressDone: 4420,
  handoverStart: 4420,
  handoverMs: 460,
} as const;

/** Reduced motion: no fading or sweep; a brief, static reveal, then handover. Intentionally
    stays short regardless of the full timeline — that is the point of the preference. */
export const REDUCED_TIMELINE = {
  logoIn: 0,
  hornAt: 0,
  progressIn: 60,
  progressDone: 640,
  handoverStart: 640,
  handoverMs: 160,
} as const;

/**
 * One continuous easing 0→100 for the whole progress window (pure, testable).
 * A single ease-in-out cubic — no two-beat curve, no derivative kinks and therefore no
 * visible change of speed at any point; the arc and the percentage read the same value.
 */
export function bootProgressPct(elapsedMs: number, doneAt: number): number {
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= doneAt) return 100;
  const t = elapsedMs / doneAt;
  const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  return Math.min(100, Math.max(0, eased * 100));
}

const R = 52; // arc radius

interface BootOverlayProps {
  /** The boot surface and elements follow the device's effective theme. */
  theme: 'light' | 'dark';
  lang: 'en' | 'ar';
  reducedMotion: boolean;
  /** Called exactly once per run, at the beat that also starts the visual progress. */
  onHorn: () => void;
  /** Called once when the cross-fade has fully ended (parent removes the overlay). */
  onFinished: () => void;
  /** Keyed remount id, only used for `data-boot-run` debugging/QA hooks. */
  run: number;
}

export interface BootDebugEvent { t: number; run: number; ev: string; detail?: string }

/** Development builds only: `import.meta.env.DEV` is vite-injected; production bundles drop
    the QA telemetry entirely (tree-shaken dead code), with no effect on boot behaviour. */
const BOOT_TELEMETRY_ENABLED = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

/** QA telemetry: appends to window.__gmBootDebug so manual playback tests can be verified
    honestly. Kept deliberately tiny; nothing here drives behaviour. */
function bootDebug(ev: string, run: number, detail?: string) {
  if (!BOOT_TELEMETRY_ENABLED) return;
  try {
    const w = window as unknown as { __gmBootDebug?: BootDebugEvent[] };
    (w.__gmBootDebug = w.__gmBootDebug || []).push({ t: Math.round(performance.now()), run, ev, detail });
  } catch { /* telemetry never breaks the boot */ }
}

/**
 * One full boot run: mounted with a fresh React key per replay so all timers/animation state
 * restart cleanly. Audio is owned by the parent (single Audio element, never overlapped).
 */
export function BootOverlay({ theme, lang, reducedMotion, onHorn, onFinished, run }: BootOverlayProps) {
  const T = reducedMotion ? REDUCED_TIMELINE : BOOT_TIMELINE;
  const copy = bootCopy(lang);
  const [pct, setPct] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const hornRef = useRef(onHorn);
  hornRef.current = onHorn;
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  // Single rAF/timeout driver: no CSS-transition listeners to miss, so repeated replays can't jam.
  useEffect(() => {
    let raf = 0;
    let done = false;
    const startAt = performance.now();
    bootDebug('boot-start', run);

    if (reducedMotion) {
      // Instant reveal; short static display, then hand over straight away (no fade).
      const t1 = window.setTimeout(() => { bootDebug('horn', run, 'reduced'); hornRef.current(); }, T.hornAt);
      const t2 = window.setTimeout(() => finish(), T.handoverStart + T.handoverMs);
      return () => { window.clearTimeout(t1); window.clearTimeout(t2); cancelAnimationFrame(raf); };
    }

    let startedHorn = false;
    let leavingStarted = false;
    const tick = () => {
      const elapsed = performance.now() - startAt;
      if (!startedHorn && elapsed >= T.hornAt) {
        startedHorn = true;
        bootDebug('horn', run, `at~${Math.round(elapsed)}ms`);
        hornRef.current(); // same beat as the visual progress, which starts below
      }
      // One eased value drives both arc and percentage, sampled every frame (floats — the arc
      // never rounds between frames, so it cannot step); the percentage rounds only for text.
      setPct(elapsed >= T.progressIn
        ? bootProgressPct(elapsed - T.progressIn, T.progressDone - T.progressIn)
        : 0);
      // At handover: hold 100%, let the cross-fade play to the end, then remove the overlay.
      if (elapsed >= T.handoverStart && !leavingStarted) {
        leavingStarted = true;
        setPct(100);
        setLeaving(true);
        bootDebug('handover', run);
        window.setTimeout(() => finish(), T.handoverMs);
        return; // CSS animation takes over from here
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);

    function finish() {
      if (done) return;
      done = true;
      bootDebug('done', run);
      finishedRef.current();
    }
  }, [reducedMotion, T.hornAt, T.handoverStart, T.handoverMs, T.progressIn, T.progressDone]);

  // Thin sweep drawn with pathLength so the arithmetic stays simple: `X 100` covers X% of the arc.
  // Hidden until the first real movement so the round cap can't show a stray dot at rest.
  const sweep = `${Math.max(pct, 0)} 100`;

  return (
    <div className={`boot is-${theme}${reducedMotion ? ' is-reduced' : ''}${leaving ? ' boot-overlay-leaving' : ''}`} data-boot-run={run} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      {/* Arc + logo + percentage: one unified centred element — the logo inside the thin arc,
          the live percentage directly beneath it, aligned to the same centre line. Purely
          visual start-up ambience, intentionally not exposed as a live region, so assistive
          technology only ever announces the app itself, never boot decoration. */}
      <div className="boot-center" aria-hidden="true">
        <div className="boot-arc">
          <svg viewBox="0 0 120 120" width="148" height="148" focusable="false">
            <circle className="boot-arc-track" cx="60" cy="60" r={R} fill="none" strokeWidth="2.5" />
            <circle className="boot-arc-sweep" cx="60" cy="60" r={R} fill="none" strokeWidth="2.5"
              pathLength={100} strokeDasharray={sweep} transform="rotate(-90 60 60)"
              strokeLinecap="round" style={{ visibility: pct > 0.1 ? 'visible' : 'hidden' }} />
          </svg>
        </div>
        <img className="boot-logo" src="/assets/logos/atco-marine-logo.png" alt="ATCO Marine"
          width="148" height="84" loading="eager" decoding="async" />
      </div>
      {/* Percentage directly beneath the ring, on the same centre line — its own grid row, so the
          148px arc frame is never overlapped by the moving number. */}
      <div className="boot-pct" aria-hidden="true">{Math.round(pct)}<span className="boot-pct-sign">%</span></div>
      <div className="boot-copy" aria-hidden="true">
        <div className="boot-caption">{pct >= 100 ? copy.ready : copy.caption}</div>
        <div className="boot-sim">{copy.simNote}</div>
      </div>
    </div>
  );
}
