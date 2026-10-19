import { useCallback, useEffect, useRef, useState } from 'react';

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

  /* Fit the frame into the available stage area (window and fullscreen aware).
     ResizeObserver gives instant response; a light interval re-check keeps the
     fit correct even where resize events/RO are throttled or unavailable. */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let last = -1;
    const update = () => {
      const r = stage.getBoundingClientRect();
      const s = Math.min(1, (r.width - 32) / device.outer.w, (r.height - 24) / device.outer.h);
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

  const backToStart = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (win) {
      try { win.location.href = '/'; } catch { /* fall through */ }
    }
    const frame = iframeRef.current;
    if (frame) frame.src = '/';
  }, []);

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
          <button type="button" className="pres-btn" onClick={backToStart} title="Load the app's home screen">
            ↺ Home
          </button>
          <button type="button" className="pres-btn pres-btn-primary" onClick={toggleFullscreen}>
            {fullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>
      </header>

      <div className="pres-stage" ref={stageRef}>
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
              <iframe
                ref={iframeRef}
                className="pres-screen"
                src="/"
                title="Gulf Mover application"
                onLoad={syncFrameStyle}
              />
            </div>
            {deviceId === 'iphone' && <span className="pres-island" aria-hidden="true" />}
            {deviceId === 'android' && <span className="pres-cam" aria-hidden="true" />}
          </div>
        </div>
        <p className="pres-help">
          Tip: interact with the app inside the frame · phone previews scroll independently ·
          sign-in and demo data carry across devices · press Esc to leave full screen.
        </p>
        {fsError && !fullscreen && (
          <p className="pres-fs-note" role="status">
            Full screen is not available here — the presentation still works in the window.
          </p>
        )}
      </div>
    </div>
  );
}
