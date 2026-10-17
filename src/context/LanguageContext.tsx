import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Lang } from '../i18n/translations';
import { translateKey, translateText } from '../i18n/translate';

interface LanguageContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Translate a dictionary key. */
  t: (key: string) => string;
  /** Translate free English text (data values, notes); no-op in English. */
  tx: (text: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

export function LanguageProvider({ children, initialLang = 'en' }: { children: ReactNode; initialLang?: Lang }) {
  const [lang, setLang] = useState<Lang>(initialLang);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = lang === 'ar' ? 'جلف موفر — النموذج الأولي لواجهة المستخدم' : 'Gulf Mover — UX/UI Prototype';
  }, [lang]);

  const t = useCallback((key: string) => translateKey(lang, key), [lang]);
  const tx = useCallback((text: string) => translateText(lang, text), [lang]);
  const value = useMemo(() => ({ lang, setLang, t, tx }), [lang, t, tx]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
