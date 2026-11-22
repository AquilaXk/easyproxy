import type { Page } from "../app-routing";
import type { Locale, TFn } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { IconActivity, IconBoxes, IconHardDrive, IconList, IconPlug, IconServer, IconTerminal } from "../icons";
import { NAV_GROUPS, type NavGroup } from "../nav-groups";
import { TABS } from "../pages/integrations/integration-tabs";

export interface PaletteQuickCommand {
  id: string;
  itemName: string;
  contextName: string;
  keywords?: string;
  shortcut?: string;
  run: () => void;
}

export interface PaletteSearchEntry {
  key: string;
  section: "actions" | "pages";
  Icon: NavGroup["Icon"];
  label: string;
  context: string | null;
  shortcut?: string;
  haystack: string;
  onSelect: () => void;
}

export function buildCommandPaletteEntries(options: {
  locale: Locale;
  t: TFn;
  pageLabel: (page: Page) => string;
  pageAvailable: (page: Page) => boolean;
  onNavigate: (page: Page) => void;
  onNavigateHash?: (hash: string) => void;
  quickCommands?: readonly PaletteQuickCommand[];
}): PaletteSearchEntry[] {
  const { locale, t, pageLabel, pageAvailable, onNavigate, onNavigateHash, quickCommands } = options;

  const pageEntries: PaletteSearchEntry[] = NAV_GROUPS.flatMap((group) => {
    const groupLabel = t(group.tkey);
    const pages = [...group.pages, ...(group.embedded ?? [])];
    return pages
      .filter((page) => pageAvailable(page))
      .map((page, index) => {
        const label = index === 0 ? groupLabel : pageLabel(page);
        const context = index === 0 || label === groupLabel ? null : groupLabel;
        return {
          key: `page:${page}`,
          section: "pages" as const,
          Icon: group.Icon,
          label,
          context,
          haystack: `${label} ${page} ${groupLabel}`.toLowerCase(),
          onSelect: () => onNavigate(page),
        };
      });
  });

  const extraEntries: PaletteSearchEntry[] = [];
  if (onNavigateHash) {
    if (pageAvailable("integrations")) {
      const clientsContext = uxT(locale, "cmd.sectionClients");
      for (const tab of TABS) {
        if (tab.id === "overview") continue;
        const label = t(tab.labelKey);
        const hash = tab.id === "claude"
          ? "claude"
          : tab.id === "claudeDesktop"
            ? "claude/desktop"
            : `integrations/${tab.id}`;
        const keywords = tab.id === "keys" ? "api key budget spend limit" : "";
        extraEntries.push({
          key: `tab:${tab.id}`,
          section: "pages",
          Icon: IconPlug,
          label,
          context: clientsContext,
          haystack: `${label} ${tab.id} ${clientsContext} ${keywords}`.toLowerCase(),
          onSelect: () => onNavigateHash(hash),
        });
      }
    }
    if (pageAvailable("models")) {
      const modelsContext = uxT(locale, "cmd.sectionModels");
      const modelSubTabs: Array<{ hash: string; copyKey: "cmd.combos" | "cmd.routing" | "cmd.compatibility"; tokens: string }> = [
        { hash: "models/combos", copyKey: "cmd.combos", tokens: "combos" },
        { hash: "models/routing", copyKey: "cmd.routing", tokens: "routing rules" },
        { hash: "models/compatibility", copyKey: "cmd.compatibility", tokens: "compatibility lab" },
      ];
      for (const sub of modelSubTabs) {
        const label = uxT(locale, sub.copyKey);
        extraEntries.push({
          key: `sub:${sub.hash}`,
          section: "pages",
          Icon: IconBoxes,
          label,
          context: modelsContext,
          haystack: `${label} ${modelsContext} ${sub.tokens}`.toLowerCase(),
          onSelect: () => onNavigateHash(sub.hash),
        });
      }
    }
    if (pageAvailable("dashboard") || pageAvailable("providers")) {
      const guardrailsLabel = t("proxyV2.secGuardrails");
      const targetDashboard = pageAvailable("dashboard");
      const guardrailsContext = targetDashboard ? t("nav.dashboard") : t("nav.providers");
      extraEntries.push({
        key: "deep:guardrails",
        section: "pages",
        Icon: IconServer,
        label: guardrailsLabel,
        context: guardrailsContext,
        haystack: `${guardrailsLabel} guardrails dlp secret privacy ${guardrailsContext}`.toLowerCase(),
        onSelect: () => onNavigateHash(targetDashboard ? "dashboard/proxy-guardrails" : "providers"),
      });
    }
    if (pageAvailable("logs")) {
      const debugLabel = t("logs.tabDebug");
      extraEntries.push({
        key: "deep:debug",
        section: "pages",
        Icon: IconList,
        label: debugLabel,
        context: t("nav.logs"),
        haystack: `${debugLabel} logs debug trace ${t("nav.logs")}`.toLowerCase(),
        onSelect: () => onNavigateHash("logs/debug"),
      });
    }
    if (pageAvailable("storage")) {
      const storageLabel = t("nav.storage");
      extraEntries.push({
        key: "deep:storage",
        section: "pages",
        Icon: IconHardDrive,
        label: storageLabel,
        context: t("shellV2.pageAllSettings"),
        haystack: `${storageLabel} backup restore database sqlite`.toLowerCase(),
        onSelect: () => onNavigateHash("storage"),
      });
    }
    if (pageAvailable("startup")) {
      const startupLabel = t("nav.startup");
      extraEntries.push({
        key: "deep:startup",
        section: "pages",
        Icon: IconActivity,
        label: startupLabel,
        context: t("nav.dashboard"),
        haystack: `${startupLabel} autostart login launchd`.toLowerCase(),
        onSelect: () => onNavigateHash("startup"),
      });
    }
  }

  for (const cmd of quickCommands ?? []) {
    extraEntries.push({
      key: `cmd:${cmd.id}`,
      section: "actions",
      Icon: IconTerminal,
      label: cmd.itemName,
      context: cmd.contextName,
      ...(cmd.shortcut ? { shortcut: cmd.shortcut } : {}),
      haystack: `${cmd.itemName} ${cmd.contextName} ${cmd.keywords ?? ""}`.toLowerCase(),
      onSelect: cmd.run,
    });
  }

  return [...pageEntries, ...extraEntries];
}
