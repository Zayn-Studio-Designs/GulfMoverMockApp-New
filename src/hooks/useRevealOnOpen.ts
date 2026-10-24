import { useEffect, useRef } from 'react';

/**
 * Brings a details panel into view when it opens (or switches to another record), so a click on
 * "View details" lower down the page never leaves the panel off-screen below a long list.
 * Nothing moves when the panel already starts in the upper part of the screen (e.g. beside the
 * list on a desktop).
 * The `.reveal-target` CSS class keeps it clear of the sticky header.
 */
export function useRevealOnOpen<T extends HTMLElement>(key: string | null | undefined) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!key || !el) return;
    const r = el.getBoundingClientRect();
    const header = document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 0;
    // Already readable (starts in the upper part of the screen, below the header): leave it alone.
    if (r.top < header || r.top > window.innerHeight * 0.45) el.scrollIntoView?.({ block: 'start' });
  }, [key]);
  return ref;
}
