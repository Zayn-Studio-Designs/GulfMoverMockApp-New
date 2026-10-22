import { useCallback, useEffect, useRef, useState } from 'react';
import { fromOwnOrigin, isProtocolMessage, messageTargetOrigin, type PassView, type ShellToApp } from './walletProtocol';
import { AppleAddSheet, AppleWallet } from './wallet/AppleWallet';
import { GoogleSaveSheet, GoogleWallet, QuickSettings } from './wallet/GoogleWallet';
import { useDoublePress } from './wallet/hooks';
import { OS_TEXT, type OsLang } from './wallet/osText';
import { BootOverlay } from './BootOverlay';
import { BOOT_SOUND_MANIFEST_URL, bootSoundUrl, selectBootSoundFile, embeddedBootSoundUrl } from './bootSound';
import { readThemePref, resolveEffectiveTheme } from '../context/ThemeContext';
// Reuse the one dev-only guard from the boot module (vite-injected import.meta.env.DEV).
const BOOT_DEBUG_ENABLED = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
import '../styles/fonts.css';
import './wallet/deviceWallet.css';

/**
 * Client-presentation shell. Hosts the real running app in a same-origin iframe
 * and sizes it to an Apple Mac window or a phone frame. Device switching only
 * changes the iframe's CSS size, so the app adapts without reloading and keeps
 * its demo state (session and bookings live in shared localStorage).
 */

type DeviceId = 'mac' | 'iphone' | 'android';

interface DeviceSpec {
  id: DeviceId;
  label: string;
  /** Logical CSS pixel size of the rendered screen inside the frame. */
  screen: { w: number; h: number };
  /** Total size including the device bezel. */
  outer: { w: number; h: number };
}

const DEVICES: readonly DeviceSpec[] = [
  { id: 'mac', label: 'Mac', screen: { w: 1366, h: 800 }, outer: { w: 1390, h: 824 } },
  { id: 'iphone', label: 'iPhone', screen: { w: 390, h: 844 }, outer: { w: 414, h: 868 } },
  { id: 'android', label: 'Android', screen: { w: 393, h: 851 }, outer: { w: 413, h: 871 } },
];

/** What the simulated phone software is showing over the app, if anything. */
type Overlay =
  | { kind: 'wallet'; ticketId?: string }
  | { kind: 'add'; pass: PassView; alreadySaved: boolean }
  | { kind: 'qs' };

/* Subtle toolbar glyphs, matching the shell's restrained SVG style. */
const SOUND_ON_ICON = (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
    <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
    <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);
const SOUND_OFF_ICON = (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
    <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
    <path d="M16 9l5.5 5.5M21.5 9L16 14.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

const SignalIcons = () => (
  <span className="pres-statusbar-icons" aria-hidden="true">
    <svg viewBox="0 0 18 12" width="18" height="12"><path fill="currentColor" d="M1 9h3v3H1zM6 6h3v6H6zM11 3h3v9h-3zM16 0h2v12h-2z" /></svg>
    <svg viewBox="0 0 16 12" width="16" height="12"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M1.5 4.5a9.5 9.5 0 0 1 13 0M4 7.2a6 6 0 0 1 8 0" /><circle cx="8" cy="10" r="1.4" fill="currentColor" /></svg>
    <svg viewBox="0 0 27 13" width="25" height="12"><rect x="1" y="1" width="22" height="11" rx="3" fill="none" stroke="currentColor" strokeOpacity=".5" /><rect x="3" y="3" width="16" height="7" rx="1.5" fill="currentColor" /><path d="M25 4.5v4" stroke="currentColor" strokeOpacity=".5" strokeWidth="1.6" strokeLinecap="round" /></svg>
  </span>
);

/**
 * Phone status bar. It keeps the Dynamic Island / punch-hole camera clear of the app, like a
 * real phone browser. On Android it is also the pull-down for Quick Settings (Wallet tile).
 */
function StatusBar({ device, tone, hinting, quickSettingsLabel, onPull }: {
  device: 'iphone' | 'android';
  tone: 'app' | 'dark' | 'light';
  hinting: boolean;
  quickSettingsLabel: string;
  onPull: () => void;
}) {
  const cls = `pres-statusbar is-${tone}${hinting ? ' is-hinting' : ''}`;
  return device === 'android'
    ? <button type="button" className={cls} aria-label={quickSettingsLabel} onClick={onPull}><span>9:41</span><SignalIcons /></button>
    : <div className={cls} aria-hidden="true"><span>9:41</span><SignalIcons /></div>;
}

/**
 * One-off guidance after the first pass is saved: where the phone's Wallet lives. Points at the
 * iPhone side button or the Android status bar; never blocks the screen (only the bubble is
 * interactive) and goes as soon as the user does it or taps "Got it".
 */
function WalletCoach({ device, lang, onDismiss }: { device: 'iphone' | 'android'; lang: OsLang; onDismiss: () => void }) {
  const text = OS_TEXT[lang];
  return (
    <div className={`os-coach is-${device}`} role="status" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <span className="os-coach-arrow" aria-hidden="true" />
      <strong>{device === 'iphone' ? text.coachApple : text.coachGoogle}</strong>
      <span>{device === 'iphone' ? text.coachAppleSub : text.coachGoogleSub}</span>
      <button type="button" className="os-coach-btn" onClick={onDismiss}>{text.gotIt}</button>
    </div>
  );
}

export function PresentationApp() {
  const [deviceId, setDeviceId] = useState<DeviceId>('mac');
  const [scale, setScale] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [fsError, setFsError] = useState(false);
  const device = DEVICES.find(d => d.id === deviceId) as DeviceSpec;

  const shellRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  /* ---------- Simulated phone software: Wallet, system sheets, side button ---------- */
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [walletLang, setWalletLang] = useState<OsLang>('en');
  const [savedPasses, setSavedPasses] = useState<PassView[]>([]);
  const [closeSignal, setCloseSignal] = useState(0);
  const [sideHint, setSideHint] = useState(false);
  const [coach, setCoach] = useState<'iphone' | 'android' | null>(null);
  /* Guidance only until Wallet has been opened once on that phone. */
  const walletOpened = useRef({ iphone: false, android: false });
  const markWalletOpened = (device: 'iphone' | 'android') => {
    walletOpened.current[device] = true;
    setCoach(null);
    setSideHint(false);
    window.clearTimeout(hintTimer.current);
  };
  const offerCoach = (device: 'iphone' | 'android') => { if (!walletOpened.current[device]) setCoach(device); };
  const [sidePressed, setSidePressed] = useState(false);
  /* ---------- Boot sequence: replay control, horn audio, effective theme ---------- */
  // Each boot run mounts a fresh BootOverlay by key, so clicks during an existing animation can
  // never leave a stale one behind. The overlay sits in the shell — the iframe (app) never
  // reloads, so session, navigation, language and demo state are untouched.
  const [bootRun, setBootRun] = useState(0);
  const [bootVisible, setBootVisible] = useState(false);
  // Sound preference (persisted). The actual file is chosen by `boot-sound.json` in the audio
  // folder, so the sound can be replaced without touching application code.
  const SOUND_KEY = 'gm-pres-boot-sound';
  const [soundOn, setSoundOn] = useState<boolean>(() => {
    try { return localStorage.getItem(SOUND_KEY) !== 'no'; } catch { return true; }
  });
  // Set briefly when the browser refuses to start playback (autoplay policy); a click on the
  // sound button (or any toolbar interaction) counts as a user gesture and clears it.
  const [soundBlockedHint, setSoundBlockedHint] = useState(false);
  // One Audio instance for the horn: replay stops and rewinds it instead of stacking players.
  const hornRef = useRef<HTMLAudioElement | null>(null);
  // Resolved sound file (from boot-sound.json) is cached; a null means "checked, none usable".
  const soundFileRef = useRef<{ touched: boolean; file: string | null }>({ touched: false, file: null });

  /** Reads the manifest once per session; re-reads if a fetch fails so saving the file helps. */
  const resolveSoundFile = useCallback(async (): Promise<string | null> => {
    if (soundFileRef.current.touched) return soundFileRef.current.file;
    try {
      const res = await fetch(BOOT_SOUND_MANIFEST_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const file = selectBootSoundFile(await res.json());
      soundFileRef.current = { touched: true, file };
      bootDebug('manifest', file || 'no-usable-file');
    } catch (err) {
      // Missing/unusable manifest: stay silent this session, but retry on the next boot.
      bootDebug('manifest-failed', String(err instanceof Error ? err.message : err));
    }
    return soundFileRef.current.file;
  }, []);
  // Boot follows the app's appearance preference ('gm-theme', shared same-tab localStorage) with
  // a System default resolved from the OS — and follows live OS changes in System mode.
  const [bootTheme, setBootTheme] = useState<'light' | 'dark'>(() => resolveEffectiveTheme(readThemePref()));
  const reducedMotion = useRef(
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ).current;

  const startBoot = useCallback(() => {
    // Cancel any in-flight sequence and clear whatever the device shell is showing, then restart.
    setBootTheme(resolveEffectiveTheme(readThemePref())); // never replay a stale theme
    const horn = hornRef.current;
    if (horn) { horn.pause(); try { horn.currentTime = 0; } catch { /* not seekable yet */ } }
    setOverlay(null);
    setSideHint(false);
    setCoach(null);
    setBootVisible(true);
    setBootRun(n => n + 1);
  }, []);

  const finishBoot = useCallback(() => setBootVisible(false), []);

  // Dev/QA telemetry into the same window.__gmBootDebug channel used by BootOverlay:
  // records the horn resolution chain honestly (called, resolved file, play outcome).
  // Development builds only: production bundles drop the calls entirely (see BootOverlay).
  const bootDebug = (ev: string, detail?: string) => {
    if (!BOOT_DEBUG_ENABLED) return;
    try {
      const w = window as unknown as { __gmBootDebug?: Array<{ t: number; ev: string; detail?: string }> };
      (w.__gmBootDebug = w.__gmBootDebug || []).push({ t: Math.round(performance.now()), ev, detail });
    } catch { /* telemetry never breaks the boot */ }
  };

  // Horn: exactly one Audio element, rewound before each play. A replaced file (new name in
  // boot-sound.json) re-creates the element; autoplay rejection is silent for the boot but
  // surfaces one gentle hint pointing at the sound button.
  const onHorn = useCallback(() => {
    bootDebug('onHorn-called', soundOn ? 'sound-on' : 'sound-off');
    if (!soundOn) return;
    const embedded = embeddedBootSoundUrl();
    void (embedded ? Promise.resolve(embedded) : resolveSoundFile().then(file => (file ? bootSoundUrl(file) : null))).then(wanted => {
      if (!wanted || !soundOn) return;
      try {
        let horn = hornRef.current;
        if (horn && horn.getAttribute('data-src') !== wanted) { horn.pause(); horn = null; hornRef.current = null; }
        if (!horn) {
          horn = new Audio(wanted);
          horn.setAttribute('data-src', wanted);
          horn.preload = 'auto';
          horn.volume = 0.72;
          // A media decode failure (wrong bytes served, bad file) is not a play() rejection —
          // surface it through the same gentle hint as an autoplay block.
          horn.addEventListener('error', () => setSoundBlockedHint(true));
          hornRef.current = horn;
        }
        horn.pause();
        try { horn.currentTime = 0; } catch { /* not seekable yet */ }
      const p = horn.play();
      bootDebug('play-called', wanted);
      if (p && typeof p.then === 'function') {
        p.then(
          () => { bootDebug('play-accepted'); setSoundBlockedHint(false); },
          (err) => { bootDebug('play-refused', String(err instanceof DOMException ? err.name : err)); setSoundBlockedHint(true); }, // autoplay policy: enable via the sound button
        );
      }
    } catch (err) {
      bootDebug('horn-exception', String(err instanceof Error ? err.message : err));
      setSoundBlockedHint(true); // audio unavailable: sequence completes silently
    }
    });
  }, [soundOn, resolveSoundFile]);

  const toggleSound = useCallback(() => {
    setSoundOn(on => {
      const next = !on;
      try { localStorage.setItem(SOUND_KEY, next ? 'yes' : 'no'); } catch { /* session only */ }
      if (!next && hornRef.current) hornRef.current.pause();
      return next;
    });
    setSoundBlockedHint(false);
  }, []);

  // Follow the effective theme for the device surface: stored pref + live OS changes.
  useEffect(() => {
    const update = () => setBootTheme(resolveEffectiveTheme(readThemePref()));
    update();
    window.addEventListener('storage', update);
    if (typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener?.('change', update);
    }
    return () => {
      window.removeEventListener('storage', update);
      if (typeof window.matchMedia === 'function') {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        mq.removeEventListener?.('change', update);
      }
    };
  }, []);

  const deviceRef = useRef(deviceId);
  deviceRef.current = deviceId;
  const savedRef = useRef(savedPasses);
  savedRef.current = savedPasses;
  const returnFocus = useRef<HTMLElement | null>(null);
  const hintTimer = useRef<number>();
  const pressTimer = useRef<number>();
  useEffect(() => () => { window.clearTimeout(hintTimer.current); window.clearTimeout(pressTimer.current); }, []);

  const postToApp = useCallback((message: ShellToApp) => {
    iframeRef.current?.contentWindow?.postMessage(message, messageTargetOrigin());
  }, []);

  const openOverlay = useCallback((next: Overlay) => {
    if (!returnFocus.current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
    setOverlay(next);
  }, []);

  const overlayClosed = useCallback(() => setOverlay(null), []);

  /* Once nothing is shown over the app any more, focus goes back where it was (side button or
     the app). A sheet whose "View" opens Wallet never passes through "nothing shown". */
  useEffect(() => {
    if (overlay) return;
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
  }, [overlay]);

  /* Messages from the app in the frame: same window and same origin only. */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow || !fromOwnOrigin(e.origin) || !isProtocolMessage(e.data)) return;
      const msg = e.data;
      const onPhone = deviceRef.current !== 'mac';
      if (msg.type === 'gm-app:ready') {
        postToApp({ type: 'gm-host:device', device: deviceRef.current });
      } else if (msg.type === 'gm-app:theme') {
        // The app resolved its own preference (System / Auto included): keep the shell chrome and
        // the next boot surface in step without reloading anything.
        setBootTheme(msg.theme);
        document.documentElement.dataset.theme = msg.theme;
        (document.documentElement.style as CSSStyleDeclaration).colorScheme = msg.theme;
      } else if (msg.type === 'gm-wallet:state') {
        setWalletLang(msg.lang);
        setSavedPasses(msg.passes);
      } else if (msg.type === 'gm-wallet:request-add' && onPhone) {
        openOverlay({ kind: 'add', pass: msg.pass, alreadySaved: savedRef.current.some(p => p.ticketId === msg.pass.ticketId) });
      } else if (msg.type === 'gm-wallet:request-open' && onPhone) {
        openOverlay({ kind: 'wallet', ticketId: msg.ticketId });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [postToApp, openOverlay]);

  /* The app adapts its Wallet buttons to the device; phone software never carries across devices.
     Switching devices plays the selected device's boot sequence (the app itself is not reloaded). */
  useEffect(() => {
    postToApp({ type: 'gm-host:device', device: deviceId });
    setOverlay(null);
    setSideHint(false);
    setCoach(null);
    returnFocus.current = null;
    setBootVisible(true);
    setBootRun(n => n + 1);
  }, [deviceId, postToApp, startBoot]);

  /* While a phone layer is up, the app behind it cannot be reached by keyboard or pointer. */
  useEffect(() => {
    iframeRef.current?.toggleAttribute('inert', overlay !== null);
  }, [overlay]);

  const pressSide = useDoublePress({
    onDouble: () => { markWalletOpened('iphone'); openOverlay({ kind: 'wallet' }); },
    onSingle: () => {
      setSideHint(true);
      window.clearTimeout(hintTimer.current);
      hintTimer.current = window.setTimeout(() => setSideHint(false), 2400);
    },
  });

  const onSideButton = () => {
    setSidePressed(true);
    window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => setSidePressed(false), 140);
    if (overlay?.kind === 'wallet') { setCloseSignal(n => n + 1); return; } // a press puts Wallet away
    if (overlay) return;
    pressSide();
  };

  const confirmAdd = (ticketId: string) => postToApp({ type: 'gm-wallet:confirm-add', ticketId });
  const osText = OS_TEXT[walletLang];
  const statusTone = overlay?.kind === 'wallet' ? (deviceId === 'iphone' ? 'dark' : 'light') : overlay?.kind === 'qs' ? 'light' : 'app';

  /* Fit the frame into the available stage area (window and fullscreen aware).
     ResizeObserver gives instant response; a light interval re-check keeps the
     fit correct even where resize events/RO are throttled or unavailable. */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let last = -1;
    const update = () => {
      const r = stage.getBoundingClientRect();
      /* Reserve the fixed hint band (and a small guard) at the bottom so the
         device frame can never be scaled up into it. Account for the actual
         rendered height of the hint band the first time we see it. */
      const hints = document.querySelector<HTMLElement>('.pres-hints');
      const hintsH = hints ? hints.getBoundingClientRect().height : 0;
      const guard = 12;
      const availW = Math.max(0, r.width - 32);
      const availH = Math.max(0, r.height - 24 - hintsH - guard);
      const s = Math.min(1, availW / device.outer.w, availH / device.outer.h);
      if (s > 0 && Math.abs(s - last) > 0.001) {
        last = s;
        setScale(s);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    window.addEventListener('resize', update);
    const iv = window.setInterval(update, 300);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      window.clearInterval(iv);
    };
  }, [device]);

  /* Restrained transition when the device changes (no iframe remount, so no reload). */
  useEffect(() => {
    frameRef.current?.animate?.(
      [{ opacity: 0.55 }, { opacity: 1 }],
      { duration: 180, easing: 'ease-out' }
    );
  }, [deviceId]);

  /* Track native fullscreen state. */
  useEffect(() => {
    const onChange = () => {
      setFullscreen(Boolean(document.fullscreenElement));
      if (!document.fullscreenElement) setFsError(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { setFsError(true); }
      return;
    }
    if (!shellRef.current?.requestFullscreen) { setFsError(true); return; }
    try {
      await shellRef.current.requestFullscreen();
      setFsError(false);
    } catch {
      setFsError(true);
    }
  }, []);

  /* Hide the app's scrollbar *inside this previewer only* — injected into the
     same-origin iframe document on every load, so the standalone site is
     unaffected and wheel/trackpad scrolling keeps working. */
  const syncFrameStyle = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (!doc) return;
      const ID = 'pres-frame-scrollbar-style';
      if (doc.getElementById(ID)) return;
      const style = doc.createElement('style');
      style.id = ID;
      style.textContent =
        'html{scrollbar-width:none;-ms-overflow-style:none}' +
        'html::-webkit-scrollbar,body::-webkit-scrollbar{width:0;height:0;display:none}';
      (doc.head || doc.documentElement).appendChild(style);
    } catch {
      /* Cross-origin or still loading: next load event will retry. */
    }
  }, []);

  /* Home: send the app back to its home screen WITHOUT reloading the iframe (session, bookings,
     settings and language all stay), and replay the boot animation from the beginning. The app
     navigates itself on 'gm-host:home' through its own router (BrowserRouter or, in the single-file
     download, MemoryRouter). The frame is never pointed at "/" when the presentation runs from a
     file: there "/" is the root of the computer's disk, and the device would show local folders. */
  const backToStart = useCallback(() => {
    const frame = iframeRef.current;
    let showingApp = true;
    try { void frame?.contentWindow?.location.href; } catch { showingApp = false; } // frame left the app (other origin)
    if (showingApp) postToApp({ type: 'gm-host:home' });
    else if (frame && /^https?:$/.test(window.location.protocol)) frame.src = '/'; // web host only: reload the app
    startBoot();
  }, [postToApp, startBoot]);

  return (
    <div
      ref={shellRef}
      className="pres-shell"
      data-device={deviceId}
      data-fullscreen={fullscreen ? 'yes' : 'no'}
    >
      <header className="pres-toolbar">
        <div className="pres-brand">
          <span className="pres-brand-dot" aria-hidden="true" />
          <div>
            <div className="pres-brand-name">GULF MOVER</div>
            <div className="pres-brand-sub">Marine Taxi · client presentation</div>
          </div>
        </div>

        <div className="pres-center">
          <div className="pres-seg" role="group" aria-label="Preview device">
            {DEVICES.map(d => (
              <button
                key={d.id}
                type="button"
                className={'pres-seg-btn' + (d.id === deviceId ? ' active' : '')}
                aria-pressed={d.id === deviceId}
                onClick={() => setDeviceId(d.id)}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div className="pres-status" aria-live="polite">
            Showing: <strong>{device.label}</strong>
            <span className="pres-dims">{device.screen.w} × {device.screen.h}</span>
          </div>
        </div>

        <div className="pres-actions">
          {/* One unobtrusive control for sound; if autoplay was refused it raises a gentle hint. */}
          <button type="button" className={'pres-btn pres-btn-icon' + (soundBlockedHint ? ' is-attention' : '')}
            onClick={toggleSound}
            aria-pressed={!soundOn}
            aria-label={soundOn ? 'Mute the boot sound' : 'Enable the boot sound'}
            title={soundOn ? 'Sound on — click to mute' : 'Sound off — click to enable'}>
            {soundOn ? SOUND_ON_ICON : SOUND_OFF_ICON}
            <span className="pres-btn-icon-label">{soundOn ? 'Sound on' : 'Sound off'}</span>
          </button>
          {/* Home replays the boot sequence of the selected device (no page/iframe reload). */}
          <button type="button" className="pres-btn" onClick={backToStart} title="Back to the home screen with the boot animation" data-pres-home>
            ↺ Home
          </button>
          <button type="button" className="pres-btn pres-btn-primary" onClick={toggleFullscreen}>
            {fullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>
      </header>

      <div className="pres-stage">
        {/* The device is centred and scaled inside this area, which sits between the toolbar
            and the hint band, so the frame can never overlap the hints or leave the window. */}
        <div className="pres-device-area" ref={stageRef}>
        <div
          ref={frameRef}
          className={'pres-device pres-device-' + deviceId}
          style={{
            width: device.outer.w,
            height: device.outer.h,
            transform: `translate(-50%, -50%) scale(${scale})`,
          }}
        >
          <div className="pres-frame">
            <div className="pres-viewport">
              {deviceId !== 'mac' && (
                <StatusBar device={deviceId} tone={statusTone} hinting={coach === 'android' && deviceId === 'android'}
                  quickSettingsLabel={osText.openQuickSettings}
                  onPull={() => { if (!overlay) { setCoach(null); openOverlay({ kind: 'qs' }); } }} />
              )}
              <iframe
                ref={iframeRef}
                className="pres-screen"
                src="/"
                title="Gulf Mover application"
                onLoad={() => { syncFrameStyle(); postToApp({ type: 'gm-host:device', device: deviceRef.current }); }}
              />
              {bootVisible && (
                <BootOverlay key={bootRun} run={bootRun} theme={bootTheme} lang={walletLang as 'en' | 'ar'}
                  reducedMotion={reducedMotion} onHorn={onHorn} onFinished={finishBoot} />
              )}
              {deviceId === 'iphone' && overlay?.kind === 'wallet' && (
                <AppleWallet lang={walletLang} passes={savedPasses} focusTicketId={overlay.ticketId}
                  closeSignal={closeSignal} onClosed={overlayClosed} />
              )}
              {deviceId === 'iphone' && overlay?.kind === 'add' && (
                <AppleAddSheet lang={walletLang} pass={overlay.pass} alreadySaved={overlay.alreadySaved}
                  onAdd={() => confirmAdd(overlay.pass.ticketId)}
                  onAdded={() => offerCoach('iphone')}
                  onView={() => { markWalletOpened('iphone'); openOverlay({ kind: 'wallet', ticketId: overlay.pass.ticketId }); }}
                  onClosed={overlayClosed} />
              )}
              {deviceId === 'android' && overlay?.kind === 'wallet' && (
                <GoogleWallet lang={walletLang} passes={savedPasses} focusTicketId={overlay.ticketId} onClosed={overlayClosed} />
              )}
              {deviceId === 'android' && overlay?.kind === 'add' && (
                <GoogleSaveSheet lang={walletLang} pass={overlay.pass} alreadySaved={overlay.alreadySaved}
                  onSave={() => confirmAdd(overlay.pass.ticketId)}
                  onView={() => { markWalletOpened('android'); openOverlay({ kind: 'wallet', ticketId: overlay.pass.ticketId }); }}
                  onClosed={saved => { overlayClosed(); if (saved) offerCoach('android'); }} />
              )}
              {deviceId === 'android' && overlay?.kind === 'qs' && (
                <QuickSettings lang={walletLang} onWallet={() => { markWalletOpened('android'); openOverlay({ kind: 'wallet' }); }} onClosed={overlayClosed} />
              )}
              {sideHint && !coach && !overlay && <div className="os-hint" role="status" dir={walletLang === 'ar' ? 'rtl' : 'ltr'}>{osText.sideHint}</div>}
              {coach && coach === deviceId && !overlay && <WalletCoach device={coach} lang={walletLang} onDismiss={() => setCoach(null)} />}
            </div>
            {deviceId === 'iphone' && <span className="pres-island" aria-hidden="true" />}
            {deviceId === 'android' && <span className="pres-cam" aria-hidden="true" />}
          </div>
          {/* Hardware buttons sit on the chassis edge, outside the clipped screen. Only the
              iPhone side button is interactive (double-click → Wallet). */}
          {deviceId === 'iphone' && (
            <>
              <span className="pres-hw pres-hw-action" aria-hidden="true" />
              <span className="pres-hw pres-hw-vol-up" aria-hidden="true" />
              <span className="pres-hw pres-hw-vol-down" aria-hidden="true" />
              <button type="button" className={'pres-side-btn' + (sidePressed ? ' is-pressed' : '') + (coach === 'iphone' ? ' is-hinting' : '')}
                aria-label={osText.sideButton} title={osText.sideButton} onClick={onSideButton} />
            </>
          )}
          {deviceId === 'android' && (
            <>
              <span className="pres-hw pres-hw-power" aria-hidden="true" />
              <span className="pres-hw pres-hw-vol" aria-hidden="true" />
            </>
          )}
        </div>
        </div>
        <div className="pres-hints" aria-live="polite">
          {deviceId === 'iphone' && (
            <p className="pres-help pres-wallet-help">
              Wallet demo: in the app open a ticket and tap “Add to Apple Wallet”, then double-click the phone’s side button (right edge).
            </p>
          )}
          {deviceId === 'android' && (
            <p className="pres-help pres-wallet-help">
              Wallet demo: in the app open a ticket and tap “Add to Google Wallet”, or tap the phone’s status bar and choose Google Wallet.
            </p>
          )}
          <p className="pres-help">
            Tip: interact with the app inside the frame · phone previews scroll independently ·
            sign-in and demo data carry across devices · press Esc to leave full screen.
          </p>
          {soundBlockedHint && (
            <p className="pres-fs-note" role="status">
              The boot sound was held back by your browser. Click the sound button once to enable it.
            </p>
          )}
          {fsError && !fullscreen && (
            <p className="pres-fs-note" role="status">
              Full screen is not available here — the presentation still works in the window.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
