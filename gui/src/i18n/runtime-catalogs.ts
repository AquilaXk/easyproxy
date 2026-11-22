import type { Locale, TKey } from "./locale-meta";

export type Dict = Record<TKey, string>;

const EMPTY_DICT = {} as Dict;
const LOADED_CATALOGS: Partial<Record<Locale, Dict>> = {};
const IN_FLIGHT_CATALOGS = new Map<Locale, Promise<Dict>>();
let lastLoadedDict: Dict | null = null;
let catalogLoadVersion = 0;
const catalogListeners = new Set<() => void>();
let catalogImporterOverrideForTests: ((locale: Locale) => Promise<Dict>) | null = null;

function notifyCatalogListeners(): void {
  catalogLoadVersion += 1;
  for (const listener of catalogListeners) listener();
}

export function subscribeCatalogLoads(listener: () => void): () => void {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
}

export function getCatalogLoadVersion(): number {
  return catalogLoadVersion;
}

export function hasAnyLoadedCatalog(): boolean {
  return lastLoadedDict !== null || LOADED_CATALOGS.en !== undefined || Object.keys(LOADED_CATALOGS).length > 0;
}

declare const require: ((id: string) => unknown) | undefined;

// In Bun test / dev mode (!import.meta.env.PROD), populate all catalogs synchronously
// so helpers and synchronous DOM tests reading non-English locales work immediately.
// Vite statically substitutes import.meta.env.PROD === true and drops this branch.
if (!import.meta.env.PROD && typeof require === "function") {
  const mod = require("./catalogs") as { DICTS: Record<Locale, Dict> };
  Object.assign(LOADED_CATALOGS, mod.DICTS);
}

async function loadRawCatalogChunk(locale: Locale): Promise<Dict> {
  switch (locale) {
    case "en": return (await import("./en")).en;
    case "zh": return (await import("./zh")).zh;
    case "zh-TW": return (await import("./zh-TW")).zhTW;
    case "ko": return (await import("./ko")).ko;
    case "fr": return (await import("./fr")).fr;
    case "de": return (await import("./de")).de;
    case "vi": return (await import("./vi")).vi;
    case "pt": return (await import("./pt")).pt;
    case "ru": return (await import("./ru")).ru;
    case "ja": return (await import("./ja")).ja;
    case "tr": return (await import("./tr")).tr;
  }
}

async function importCatalogChunk(locale: Locale): Promise<Dict> {
  const [dict, { LAB_CATALOG_OVERRIDES }] = await Promise.all([
    loadRawCatalogChunk(locale),
    import("./lab-translations"),
  ]);
  return { ...dict, ...LAB_CATALOG_OVERRIDES[locale] };
}

export function isLocaleLoaded(locale: Locale, _version?: number): boolean {
  return LOADED_CATALOGS[locale] !== undefined;
}

export function getLoadedDict(locale: Locale, _version?: number): Dict {
  return LOADED_CATALOGS[locale] ?? LOADED_CATALOGS.en ?? lastLoadedDict ?? EMPTY_DICT;
}

export function catalogValue(locale: Locale, key: TKey): string {
  return getLoadedDict(locale)[key] ?? LOADED_CATALOGS.en?.[key] ?? key;
}

export function preloadLocaleCatalog(locale: Locale): Promise<Dict> {
  const existing = LOADED_CATALOGS[locale];
  if (existing) return Promise.resolve(existing);
  const pending = IN_FLIGHT_CATALOGS.get(locale);
  if (pending) return pending;
  const loader = catalogImporterOverrideForTests ?? importCatalogChunk;
  const task = loader(locale)
    .then((dict) => {
      LOADED_CATALOGS[locale] = dict;
      lastLoadedDict = dict;
      IN_FLIGHT_CATALOGS.delete(locale);
      notifyCatalogListeners();
      return dict;
    })
    .catch((err) => {
      IN_FLIGHT_CATALOGS.delete(locale);
      throw err;
    });
  IN_FLIGHT_CATALOGS.set(locale, task);
  return task;
}

export function resetRuntimeCatalogsForTests(loader: ((locale: Locale) => Promise<Dict>) | null = null): void {
  for (const key of Object.keys(LOADED_CATALOGS) as Locale[]) {
    delete LOADED_CATALOGS[key];
  }
  IN_FLIGHT_CATALOGS.clear();
  lastLoadedDict = null;
  catalogImporterOverrideForTests = loader;
  if (!loader && !import.meta.env.PROD && typeof require === "function") {
    const mod = require("./catalogs") as { DICTS: Record<Locale, Dict> };
    Object.assign(LOADED_CATALOGS, mod.DICTS);
  }
  notifyCatalogListeners();
}
