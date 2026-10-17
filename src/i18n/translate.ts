import { EXTRA_AR, I18N, type Lang } from './translations';

/** Key lookup with English fallback, then the key itself (matches the prototype's `t`). */
export function translateKey(lang: Lang, key: string): string {
  return I18N[lang]?.[key] ?? I18N.en[key] ?? key;
}

// English phrase → Arabic phrase, longest first so longer phrases win over their substrings.
const AR_TEXT_MAP: ReadonlyArray<readonly [string, string]> = (() => {
  const map = new Map<string, string>();
  for (const key of Object.keys(I18N.en)) {
    const en = I18N.en[key];
    const ar = I18N.ar[key];
    if (en && ar && en !== ar && !map.has(en)) map.set(en, ar);
  }
  for (const [en, ar] of EXTRA_AR) map.set(en, ar);
  return [...map.entries()].sort((a, b) => b[0].length - a[0].length);
})();

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Translates free English text (data values, inline notes) into Arabic by phrase substitution,
 * exactly as the prototype's DOM walker does. Single words only match on word boundaries so that
 * identifiers such as GM-DEMO-0248 are left untouched.
 */
export function translateText(lang: Lang, value: string): string {
  if (lang !== 'ar') return value;
  let out = value;
  for (const [en, ar] of AR_TEXT_MAP) {
    if (!en || !out.includes(en)) continue;
    if (/^[A-Za-z]+$/.test(en)) {
      const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(en)}(?![A-Za-z0-9_-])`, 'g');
      out = out.replace(re, (_, prefix: string) => prefix + ar);
    } else {
      out = out.split(en).join(ar);
    }
  }
  return out;
}
