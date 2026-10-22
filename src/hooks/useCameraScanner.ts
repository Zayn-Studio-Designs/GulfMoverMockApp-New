import { useEffect, useRef, useState } from 'react';

type ScannerState = 'idle' | 'starting' | 'active' | 'denied' | 'unsupported' | 'error';

interface BarcodeDetectorLike {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
}

function makeDetector(): BarcodeDetectorLike | null {
  // BarcodeDetector is Chromium-only; Safari users get the manual lookup fallback.
  const Detection = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
  if (!Detection) return null;
  try {
    return new Detection({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

/**
 * Opt-in camera scanning for the boarding demo. The camera is only opened when
 * the user explicitly starts scanning, and denial/absence never breaks the page.
 */
export function useCameraScanner(active: boolean, onDetect: (payload: string) => void) {
  const [state, setState] = useState<ScannerState>('idle');
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!active) { setState('idle'); return; }
    // Per-run flag: after a quick off/on, a still-pending earlier run must see that it was stopped,
    // otherwise it attaches (and never releases) its camera stream. A shared ref was reset by the new run.
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;

    const fail = (s: ScannerState) => { if (!stopped) setState(s); };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { fail('unsupported'); return; }
      setState('starting');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      } catch {
        fail('denied');
        return;
      }
      if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
      const video = videoRef.current;
      if (!video) { stream.getTracks().forEach(t => t.stop()); fail('error'); return; }
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      try { await video.play(); } catch { /* autoplay guards: ignore */ }
      if (stopped) return; // turned off while the preview was starting; cleanup already released the stream
      const detector = makeDetector();
      if (!detector) {
        // Frames still preview, but decoding is unavailable: tell the operator.
        setState('unsupported');
        return;
      }
      setState('active');
      const poll = async () => {
        if (stopped) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length > 0) onDetect(codes[0].rawValue);
        } catch { // transient decode errors are ignored
        }
        timer = window.setTimeout(poll, 400);
      };
      void poll();
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      videoRef.current && (videoRef.current.srcObject = null);
      stream?.getTracks().forEach(t => t.stop());
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return { state, videoRef };
}
