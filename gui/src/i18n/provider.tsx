import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { I18nContext, LOCALES, detectInitial, interpolate, setActiveLocale, type Locale, type TFn, type TKey, type Vars } from "./shared";
import {
  getCatalogLoadVersion,
  getLoadedDict,
  hasAnyLoadedCatalog,
  isLocaleLoaded,
  preloadLocaleCatalog,
  subscribeCatalogLoads,
} from "./runtime-catalogs";
import { useI18n } from "./shared";

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(() => {
    const initial = detectInitial();
    setActiveLocale(initial);
    return initial;
  });

  // Subscribe to async catalog loads so a chunk settling between initial render
  // and effect execution still triggers a render in production builds.
  const catalogVersion = useSyncExternalStore(
    subscribeCatalogLoads,
    getCatalogLoadVersion,
    getCatalogLoadVersion,
  );
  const [catalogFailed, setCatalogFailed] = useState(false);

  useEffect(() => {
    if (isLocaleLoaded(locale)) return;
    let cancelled = false;
    void preloadLocaleCatalog(locale)
      .then(() => {
        if (!cancelled) setCatalogFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        if (locale === "en" || isLocaleLoaded("en")) {
          setCatalogFailed(true);
          return;
        }
        void preloadLocaleCatalog("en")
          .then(() => {
            if (!cancelled) setCatalogFailed(false);
          })
          .catch(() => {
            if (!cancelled) setCatalogFailed(true);
          });
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

  const ready = isLocaleLoaded(locale, catalogVersion)
    || isLocaleLoaded("en", catalogVersion)
    || hasAnyLoadedCatalog();

  const dict = getLoadedDict(locale, catalogVersion);
  const enFallback = isLocaleLoaded("en", catalogVersion)
    ? getLoadedDict("en", catalogVersion)
    : undefined;

  const t: TFn = useCallback(
    (key, vars) => interpolate(dict[key] ?? enFallback?.[key] ?? key, vars),
    [dict, enFallback],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  if (!ready && !catalogFailed) return null;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function Trans({ k, cmd, vars }: { k: TKey; cmd: string; vars?: Vars }) {
  const { t } = useI18n();
  const [pre, post = ""] = t(k, vars).split("{cmd}");
  return <>{pre}<code className="chip">{cmd}</code>{post}</>;
}
