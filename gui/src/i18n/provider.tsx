import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { I18nContext, LOCALES, detectInitial, interpolate, setActiveLocale, type Locale, type TFn, type TKey, type Vars } from "./shared";
import { getLoadedDict, isLocaleLoaded, preloadLocaleCatalog } from "./runtime-catalogs";
import { useI18n } from "./shared";

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(() => {
    const initial = detectInitial();
    setActiveLocale(initial);
    return initial;
  });

  const [loadedDicts, setLoadedDicts] = useState<Partial<Record<Locale, Record<TKey, string>>>>({});

  useEffect(() => {
    if (isLocaleLoaded(locale)) return;
    let cancelled = false;
    void preloadLocaleCatalog(locale)
      .then((loaded) => {
        if (!cancelled) {
          setLoadedDicts((prev) => ({ ...prev, [locale]: loaded }));
        }
      })
      .catch(() => {
        // Fallback to already-loaded en catalog if the async chunk fails to load.
      });
    return () => { cancelled = true; };
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setActiveLocale(next);
    setLocaleState(next);
  }, []);

  useEffect(() => {
    const meta = LOCALES.find(l => l.code === locale) ?? LOCALES[0];
    document.documentElement.lang = meta.htmlLang;
    try { localStorage.setItem("epx-lang", locale); } catch { /* ignore */ }
  }, [locale]);

  const ready = isLocaleLoaded(locale) || isLocaleLoaded("en") || Boolean(loadedDicts[locale]);
  const [hasRenderedCatalog, setHasRenderedCatalog] = useState(ready);
  useEffect(() => {
    if (ready && !hasRenderedCatalog) setHasRenderedCatalog(true);
  }, [ready, hasRenderedCatalog]);

  const dict = loadedDicts[locale] ?? getLoadedDict(locale);
  const enFallback = loadedDicts.en ?? (isLocaleLoaded("en") ? getLoadedDict("en") : undefined);

  const t: TFn = useCallback(
    (key, vars) => interpolate(dict[key] ?? enFallback?.[key] ?? key, vars),
    [dict, enFallback],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  if (!hasRenderedCatalog && !ready) return null;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function Trans({ k, cmd, vars }: { k: TKey; cmd: string; vars?: Vars }) {
  const { t } = useI18n();
  const [pre, post = ""] = t(k, vars).split("{cmd}");
  return <>{pre}<code className="chip">{cmd}</code>{post}</>;
}
