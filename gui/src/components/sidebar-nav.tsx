/**
 * The sidebar's rows, with an Antigravity Command Palette (⌘K) search dialog,
 * keyboard shortcuts for core workspaces, and a folded Fine-tuning tier.
 *
 * Rows come from nav-groups.ts, one tier at a time; this file only decides how they are
 * shown. Search covers every workspace, sub-tab, deep link, and quick command.
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Page } from "../app-routing";
import { getActiveLocale, type Locale, type TFn } from "../i18n/shared";
import { uxT } from "../i18n/ux-overhaul-copy";
import { IconChevron, IconSearch, IconX } from "../icons";
import { NAV_GROUPS, NAV_TIERS, type NavGroup, type NavGroupId, type NavTier } from "../nav-groups";
import { buildCommandPaletteEntries, type PaletteQuickCommand, type PaletteSearchEntry } from "../lib/command-palette";
import type { GatewayAlerts } from "../lib/gateway-alerts";
import { isEditableTarget, numberModifierHeld, searchShortcutLabel, settingsShortcutLabel, shortcutLabel, shortcutStyle } from "../lib/nav-shortcuts";
import { topmostOverlayLayer } from "./overlay-layers";

const ADVANCED_OPEN_KEY = "epx-nav-advanced-open";
/** The tier that folds. Everything in it stays reachable through search and the active row. */
const FOLDING_TIER: NavTier = "advanced";

function readAdvancedOpen(): boolean {
  try {
    return localStorage.getItem(ADVANCED_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function SidebarNav({ activeGroupId, pageLabel, pageAvailable, onNavigate, onReveal, desktopShell, t, locale, onNavigateHash, quickCommands, alerts }: {
  activeGroupId: NavGroupId | null;
  pageLabel: (page: Page) => string;
  /** Search offers only pages that can load now (Remote Workspace needs a hub). */
  pageAvailable: (page: Page) => boolean;
  onNavigate: (page: Page) => void;
  /** Make the sidebar visible (expand a collapsed rail, open the phone drawer) before focusing search. */
  onReveal: () => void;
  desktopShell: boolean;
  t: TFn;
  locale?: Locale;
  onNavigateHash?: (hash: string) => void;
  quickCommands?: readonly PaletteQuickCommand[];
  alerts?: GatewayAlerts;
}) {
  const style = useMemo(() => shortcutStyle(desktopShell), [desktopShell]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(readAdvancedOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchDialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const openedFromButton = useRef(false);
  const restoreFocusOnCloseRef = useRef(true);
  const listId = useId();

  useEffect(() => {
    try {
      localStorage.setItem(ADVANCED_OPEN_KEY, advancedOpen ? "1" : "0");
    } catch {
      // A storageless context still folds for the session.
    }
  }, [advancedOpen]);

  const activeLocale = locale ?? getActiveLocale();

  const entries = useMemo<PaletteSearchEntry[]>(
    () => buildCommandPaletteEntries({
      locale: activeLocale,
      t,
      pageLabel,
      pageAvailable,
      onNavigate,
      onNavigateHash,
      quickCommands,
    }),
    [activeLocale, onNavigate, onNavigateHash, pageAvailable, pageLabel, quickCommands, t],
  );

  const curatedDefaults = useMemo(
    () => [
      ...entries.filter(entry => entry.section === "actions"),
      ...entries.filter(entry => entry.key.startsWith("page:")),
    ],
    [entries],
  );

  const trimmed = query.trim().toLowerCase();
  const results = useMemo(
    () => (trimmed ? entries.filter(entry => entry.haystack.includes(trimmed)) : curatedDefaults),
    [curatedDefaults, entries, trimmed],
  );

  const openSearch = useCallback((fromButton = false) => {
    if (searching) return;
    restoreFocusOnCloseRef.current = true;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openedFromButton.current = fromButton || returnFocusRef.current === searchButtonRef.current;
    onReveal();
    setSearching(true);
  }, [onReveal, searching]);

  useEffect(() => {
    const dialog = searchDialogRef.current;
    if (!searching || !dialog) return;
    if (typeof dialog.showModal === "function") {
      try {
        if (!dialog.open) dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    // The mobile drawer or native top-layer transition may delay the first focus attempt.
    const timer = setTimeout(() => {
      if (!searchDialogRef.current?.contains(document.activeElement)) inputRef.current?.focus();
    }, 200);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [searching]);

  useEffect(() => {
    const dialog = searchDialogRef.current;
    if (!searching || !dialog) return;
    // Keep background unavailable across both native top-layer and DOM test hosts.
    const changed: Element[] = [];
    for (let node: Element | null = dialog; node?.parentElement; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling !== node && !sibling.hasAttribute("inert")) {
          sibling.setAttribute("inert", "");
          changed.push(sibling);
        }
      }
      if (node.parentElement === document.body) break;
    }
    const containFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) inputRef.current?.focus();
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      changed.forEach(element => element.removeAttribute("inert"));
    };
  }, [searching, trimmed]);

  const closeSearch = useCallback((restoreFocus: boolean) => {
    restoreFocusOnCloseRef.current = restoreFocus;
    const dialog = searchDialogRef.current;
    if (dialog?.open && typeof dialog.close === "function") {
      try { dialog.close(); } catch { dialog.removeAttribute("open"); }
    }
    setQuery("");
    setHighlight(0);
    setSearching(false);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        const target = openedFromButton.current ? searchButtonRef.current : returnFocusRef.current;
        if (target?.isConnected) target.focus();
        else searchButtonRef.current?.focus();
      });
    } else {
      searchButtonRef.current?.blur();
      requestAnimationFrame(() => {
        if (document.activeElement === searchButtonRef.current) searchButtonRef.current?.blur();
      });
    }
  }, []);

  useEffect(() => {
    if (!searching || results.length === 0) return;
    const activeIndex = Math.min(highlight, results.length - 1);
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [highlight, listId, results.length, searching]);

  const goSelect = useCallback((run: () => void) => {
    closeSearch(false);
    run();
  }, [closeSearch]);

  useEffect(() => {
    if (!searching) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSearch(true);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [closeSearch, searching]);

  const daily = useMemo(() => NAV_GROUPS.filter(group => group.tier === "daily"), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (searching || event.defaultPrevented || event.isComposing || topmostOverlayLayer()) return;
      const commandK = (style.endsWith("mac") ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey && !event.shiftKey && (event.key === "k" || event.key === "K");
      if (commandK || (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target))) {
        event.preventDefault();
        openSearch();
        return;
      }
      if (desktopShell && (style === "desktop-mac" ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        onNavigate("advanced");
        return;
      }
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (!digit || !numberModifierHeld(style, event)) return;
      if (style.startsWith("browser") && isEditableTarget(event.target)) return;
      const group = daily[Number(digit) - 1];
      if (!group) return;
      event.preventDefault();
      onNavigate(group.pages[0]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [daily, desktopShell, onNavigate, openSearch, searching, style]);

  useEffect(() => {
    const dialog = searchDialogRef.current;
    if (!searching || !dialog) return;
    const onDialogClick = (event: MouseEvent) => {
      if (event.target === dialog) {
        closeSearch(true);
        return;
      }
      const surface = dialog.querySelector(".cmdk-surface");
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      if (rect.width > 0 && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) {
        closeSearch(true);
      }
    };
    const onDialogKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSearch(true);
      } else if (event.key === "Tab") {
        event.preventDefault();
        const close = dialog.querySelector<HTMLButtonElement>(".nav-search-close");
        if (event.shiftKey ? document.activeElement === inputRef.current : document.activeElement !== close) close?.focus();
        else inputRef.current?.focus();
      }
    };
    dialog.addEventListener("click", onDialogClick);
    dialog.addEventListener("keydown", onDialogKeyDown);
    return () => {
      dialog.removeEventListener("click", onDialogClick);
      dialog.removeEventListener("keydown", onDialogKeyDown);
    };
  }, [closeSearch, searching]);

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight(index => (results.length ? (index + 1) % results.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(index => (results.length ? (index - 1 + results.length) % results.length : 0));
    } else if (event.key === "Home") {
      if (results.length) { event.preventDefault(); setHighlight(0); }
    } else if (event.key === "End") {
      if (results.length) { event.preventDefault(); setHighlight(results.length - 1); }
    } else if (event.key === "Enter") {
      const entry = results[Math.min(highlight, results.length - 1)];
      if (entry) {
        event.preventDefault();
        goSelect(entry.onSelect);
      }
    }
  };

  const searchLabel = t("shellV2.navSearch");
  const searchHint = searchShortcutLabel(style);

  const row = (group: NavGroup, shortcut: string | null) => {
    const { id, tkey, Icon } = group;
    const active = activeGroupId === id;
    const label = t(tkey);
    const alertBadge = id === "connect" && alerts && alerts.budgetWarningCount > 0
      ? {
          count: alerts.budgetWarningCount,
          tone: "warn" as const,
          label: uxT(activeLocale, "alerts.budgetWarning", { count: alerts.budgetWarningCount }),
          go: () => (onNavigateHash ? onNavigateHash("integrations/keys") : onNavigate("integrations")),
        }
      : id === "usage-logs" && alerts && alerts.rateLimitOrBlockCount > 0
        ? {
            count: alerts.rateLimitOrBlockCount,
            tone: "err" as const,
            label: uxT(activeLocale, "alerts.recentBlocks", { count: alerts.rateLimitOrBlockCount }),
            go: () => (onNavigateHash ? onNavigateHash("logs") : onNavigate("logs")),
          }
        : null;
    return (
      <div key={id} className="nav-entry">
        <button type="button" className={`nav-item${active ? " active" : ""}`}
          data-page={group.pages[0]}
          data-group={id}
          title={shortcut ? `${label} (${shortcut})` : undefined}
          aria-keyshortcuts={shortcut ? shortcut.replace("⌘", "Meta+").replace("⌥", "Alt+") : undefined}
          onClick={() => {
            searchButtonRef.current?.blur();
            onNavigate(group.pages[0]);
          }}
          aria-current={active ? "page" : undefined}>
          <Icon /> <span className="nav-item-label">{label}</span>
          {shortcut && <kbd className="nav-kbd" aria-hidden="true">{shortcut}</kbd>}
        </button>
        {alertBadge && (
          <button
            type="button"
            className={`nav-alert-pill nav-alert-pill--${alertBadge.tone}`}
            data-alert-target={id}
            title={alertBadge.label}
            aria-label={alertBadge.label}
            onClick={() => {
              searchButtonRef.current?.blur();
              alertBadge.go();
            }}
          >
            {alertBadge.count > 99 ? "99+" : alertBadge.count}
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      <button
        ref={searchButtonRef}
        type="button"
        className="nav-search-open"
        onClick={() => openSearch(true)}
        aria-label={`${searchLabel} (${searchHint})`}
        title={`${searchLabel} (${searchHint})`}
        aria-keyshortcuts={searchHint === "⌘K" ? "Meta+K" : "Control+K"}
      >
        <IconSearch aria-hidden="true" />
        <span className="nav-search-open-text">{t("shellV2.navSearchPlaceholder")}</span>
        <kbd className="nav-kbd nav-kbd--search" aria-hidden="true">{searchHint}</kbd>
      </button>
      {NAV_TIERS.map(({ tier, tkey: tierKey }) => {
        const groups = NAV_GROUPS.filter(group => group.tier === tier);
        if (tier === "daily") {
          return (
            <div key={tier} className="nav-tier" data-tier={tier}>
              <div className="nav-tier-label" aria-hidden="true">{t(tierKey)}</div>
              {groups.map((group, index) => row(group, index < 9 ? shortcutLabel(style, String(index + 1)) : null))}
            </div>
          );
        }
        if (tier !== FOLDING_TIER) {
          return (
            <div key={tier} className="nav-tier" data-tier={tier}>
              <div className="nav-tier-label" aria-hidden="true">{t(tierKey)}</div>
              {groups.map(group => row(group, null))}
            </div>
          );
        }
        const visible = advancedOpen ? groups : groups.filter(group => group.id === activeGroupId);
        return (
          <div key={tier} className={`nav-tier nav-tier--folding${advancedOpen ? " is-open" : ""}`} data-tier={tier}>
            <button type="button" className="nav-tier-toggle" aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen(open => !open)}>
              <span className="nav-tier-label">{t(tierKey)}</span>
              <IconChevron aria-hidden="true" className="nav-tier-chevron" />
            </button>
            {visible.map(group => row(group, desktopShell && group.id === "advanced" ? settingsShortcutLabel(style) : null))}
          </div>
        );
      })}
      {searching && (
        <dialog
          ref={searchDialogRef}
          {...({ closedby: "any" } as Record<string, string>)}
          aria-modal="true"
          aria-label={searchLabel}
          className="cmdk-dialog"
          onCancel={event => {
            event.preventDefault();
            closeSearch(true);
          }}
          onClose={() => {
            const shouldRestore = restoreFocusOnCloseRef.current;
            restoreFocusOnCloseRef.current = true;
            closeSearch(shouldRestore);
          }}
        >
          <div className="cmdk-surface">
            <div className="nav-search">
              <IconSearch aria-hidden="true" />
              <input
                ref={inputRef}
                type="search"
                className="nav-search-input"
                value={query}
                placeholder={t("shellV2.navSearchPlaceholder")}
                aria-label={searchLabel}
                role="combobox"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls={listId}
                aria-activedescendant={results.length ? `${listId}-${Math.min(highlight, results.length - 1)}` : undefined}
                onChange={event => { setQuery(event.target.value); setHighlight(0); }}
                onKeyDown={onSearchKey}
              />
              <button
                type="button"
                className="nav-search-close"
                onClick={() => closeSearch(true)}
                aria-label={t("common.close")}
                title={t("common.close")}
              >
                <IconX />
              </button>
            </div>
            {trimmed && results.length === 0 && (
              <div className="nav-search-empty" role="status">{t("shellV2.navSearchEmpty")}</div>
            )}
            <div id={listId} className="nav-search-results" role="listbox" aria-label={searchLabel}>
              {results.map((entry, index) => {
                const { Icon } = entry;
                const activeIndex = Math.min(highlight, results.length - 1);
                const showHeading = !trimmed && (index === 0 || results[index - 1]?.section !== entry.section);
                const showContext = entry.context && (trimmed || entry.section !== "actions");
                return (
                  <Fragment key={entry.key}>
                    {showHeading && (
                      <div className="cmdk-group-heading" aria-hidden="true">
                        {entry.section === "actions" ? uxT(activeLocale, "cmd.sectionActions") : t("shellV2.tierDaily")}
                      </div>
                    )}
                    <button
                      id={`${listId}-${index}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === activeIndex}
                      className={`nav-item nav-search-result${index === activeIndex ? " is-highlighted" : ""}`}
                      onMouseEnter={() => setHighlight(index)}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => goSelect(entry.onSelect)}
                    >
                      <Icon /> <span className="nav-item-label">{entry.label}</span>
                      {showContext && <span className="nav-search-context">{entry.context}</span>}
                      {entry.shortcut && <kbd className="nav-kbd nav-kbd--search" aria-hidden="true">{entry.shortcut}</kbd>}
                    </button>
                  </Fragment>
                );
              })}
            </div>
            <div className="cmdk-footer" aria-hidden="true">
              <span className="cmdk-footer-item"><kbd>↑</kbd><kbd>↓</kbd></span>
              <span className="cmdk-footer-item"><kbd>↵</kbd> <span>{t("shellV2.stepOpen")}</span></span>
              <span className="cmdk-footer-item"><kbd>Esc</kbd> <span>{t("common.close")}</span></span>
            </div>
          </div>
        </dialog>
      )}
    </>
  );
}
