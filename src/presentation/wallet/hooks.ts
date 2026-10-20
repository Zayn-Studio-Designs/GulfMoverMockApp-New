import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

/** Longest gap between the two presses of a double-click, in ms (iOS accepts roughly this). */
export const DOUBLE_PRESS_MS = 400;

/**
 * Tells a double press from a single one. A press waits up to `threshold` ms for a second
 * press: two presses inside the window call `onDouble` once; a lone press calls `onSingle`
 * after the window closes. Works for mouse, touch and keyboard (Enter/Space fire click).
 */
export function useDoublePress({ onSingle, onDouble, threshold = DOUBLE_PRESS_MS }: {
  onSingle?: () => void;
  onDouble: () => void;
  threshold?: number;
}) {
  const timer = useRef<number>();
  const firstAt = useRef(0);
  const callbacks = useRef({ onSingle, onDouble });
  callbacks.current = { onSingle, onDouble };

  useEffect(() => () => { window.clearTimeout(timer.current); timer.current = undefined; }, []);

  return useCallback(() => {
    const now = Date.now();
    if (timer.current !== undefined && now - firstAt.current <= threshold) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      callbacks.current.onDouble();
      return;
    }
    firstAt.current = now;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      callbacks.current.onSingle?.();
    }, threshold);
  }, [threshold]);
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Plays a closing animation, then calls `onClosed` (straight away with reduced motion). */
export function useExit(onClosed: () => void, ms: number) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<number>();
  const done = useRef(onClosed);
  done.current = onClosed;
  // Reset on unmount too: React's development double-mount must not leave a stale timer behind.
  useEffect(() => () => { window.clearTimeout(timer.current); timer.current = undefined; }, []);
  const close = useCallback(() => {
    if (timer.current !== undefined) return;
    setClosing(true);
    const delay = prefersReducedMotion() ? 0 : ms;
    timer.current = window.setTimeout(() => done.current(), delay);
  }, [ms]);
  return { closing, close };
}

/** Escape key for the open device screen (the shell document owns keyboard focus here). */
export function useEscape(handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

/** Moves focus into a newly shown screen (first element marked data-autofocus). */
export function useAutofocus(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, [dep]);
  return ref;
}

/**
 * Horizontal card carousel: mouse and touch (pointer events), arrow keys, and dots via `go`.
 * A drag only counts once it is clearly horizontal (vertical scrolling keeps working), resists at
 * the ends, and swallows the click that ends it, so swiping never opens or presses a card.
 */
export function useCarousel(count: number, start = 0) {
  const clampIndex = useCallback((i: number) => Math.max(0, Math.min(Math.max(count - 1, 0), i)), [count]);
  const [index, setIndex] = useState(() => clampIndex(start));
  const [drag, setDrag] = useState(0);
  const pointer = useRef<{ id: number; x: number; y: number; axis: 'x' | 'y' | null } | null>(null);
  const swallowClick = useRef(false);
  const width = useRef(1);

  useEffect(() => { setIndex(i => clampIndex(i)); }, [clampIndex]);
  const go = useCallback((i: number) => setIndex(clampIndex(i)), [clampIndex]);

  const end = (e: React.PointerEvent<HTMLElement>) => {
    const p = pointer.current;
    pointer.current = null;
    if (!p || p.id !== e.pointerId || p.axis !== 'x') return;
    swallowClick.current = true;
    const dx = e.clientX - p.x;
    const threshold = Math.min(70, width.current * 0.16);
    if (dx < -threshold) go(index + 1);
    else if (dx > threshold) go(index - 1);
    setDrag(0);
  };

  const handlers = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      pointer.current = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: null };
      width.current = e.currentTarget.getBoundingClientRect().width || 1;
      swallowClick.current = false;
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const p = pointer.current;
      if (!p || p.id !== e.pointerId) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (!p.axis) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        p.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (p.axis === 'x') e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      if (p.axis !== 'x') return;
      const atEdge = (index === 0 && dx > 0) || (index === count - 1 && dx < 0);
      setDrag(atEdge ? dx / 3 : dx);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture: (e: React.MouseEvent<HTMLElement>) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
  };

  return { index, go, drag, dragging: drag !== 0, handlers, onKeyDown };
}
