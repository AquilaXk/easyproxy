import type { ConfiguredProviderSummary, ProviderModelGroup } from "../models-groups";
import { filterFreeModelRows, freeOnlyInForce, modelPricingKnown, type ModelRow } from "./models-shared";

export interface DerivedGroupView {
  freeOnlyOn: boolean;
  pricingKnown: boolean;
  freeOnlyActive: boolean;
  scoped: ModelRow[];
  activeCount: number;
  filtered: ModelRow[];
  sorted: ModelRow[];
  shown: number;
  visible: ModelRow[];
  remaining: number;
  hasRows: boolean;
  selectionPending: boolean;
  allOn: boolean;
  allOff: boolean;
}

export function indexConfiguredProviders(
  providers: readonly ConfiguredProviderSummary[],
): ReadonlyMap<string, ConfiguredProviderSummary> {
  const map = new Map<string, ConfiguredProviderSummary>();
  for (const p of providers) {
    map.set(p.name, p);
  }
  return map;
}

export function flattenProviderGroupRows(groups: readonly ProviderModelGroup<ModelRow>[]): ModelRow[] {
  const out: ModelRow[] = [];
  for (const g of groups) {
    for (const row of g.rows) out.push(row);
  }
  return out;
}

export function buildProviderRailItems(
  groups: readonly ProviderModelGroup<ModelRow>[],
  isRowVisible: (provider: string, row: ModelRow) => boolean,
): Array<{ provider: string; total: number; active: number }> {
  return groups.map(({ provider, rows }) => {
    let active = 0;
    for (const row of rows) {
      if (isRowVisible(provider, row)) active += 1;
    }
    return { provider, total: rows.length, active };
  });
}

export function buildGroupViewMap(
  groups: readonly ProviderModelGroup<ModelRow>[],
  freeOnly: Readonly<Record<string, boolean>>,
  search: Readonly<Record<string, string>>,
  limit: Readonly<Record<string, number>>,
  pageSize: number,
  isRowVisible: (provider: string, row: ModelRow) => boolean,
): ReadonlyMap<string, DerivedGroupView> {
  const map = new Map<string, DerivedGroupView>();
  for (const group of groups) {
    const { provider, rows } = group;
    const freeOnlyOn = freeOnly[provider] === true;
    const pricingKnown = modelPricingKnown(rows);
    const freeOnlyActive = freeOnlyInForce(freeOnlyOn, rows);
    const scoped = filterFreeModelRows(rows, freeOnlyActive);
    let activeCount = 0;
    for (const row of scoped) {
      if (isRowVisible(provider, row)) activeCount += 1;
    }
    const q = (search[provider] ?? "").trim().toLowerCase();
    const filtered = q ? scoped.filter(m => m.id.toLowerCase().includes(q)) : scoped;
    const sorted = filtered.toSorted((a, b) => Number(!isRowVisible(provider, a)) - Number(!isRowVisible(provider, b)));
    const shown = limit[provider] ?? pageSize;
    const visible = sorted.slice(0, shown);
    const remaining = filtered.length - visible.length;
    const hasRows = scoped.length > 0;
    const selectionPending = rows.some(model => model.initialSelectionPending);
    const allOn = !hasRows || scoped.every(m => isRowVisible(provider, m));
    const allOff = !hasRows || scoped.every(m => !isRowVisible(provider, m));
    map.set(provider, {
      freeOnlyOn,
      pricingKnown,
      freeOnlyActive,
      scoped,
      activeCount,
      filtered,
      sorted,
      shown,
      visible,
      remaining,
      hasRows,
      selectionPending,
      allOn,
      allOff,
    });
  }
  return map;
}
