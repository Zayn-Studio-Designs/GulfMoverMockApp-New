import type { ReactNode } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { pillTone } from '../domain/rules';

/** Status badge: tone is derived from the English status text; the label is always shown. */
export function StatusPill({ text, className = '' }: { text: string; className?: string }) {
  const { tx } = useLanguage();
  return <span className={`pill ${pillTone(text)}${className ? ` ${className}` : ''}`}>{tx(text)}</span>;
}

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
