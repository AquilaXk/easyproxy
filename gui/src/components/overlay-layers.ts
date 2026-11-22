/**
 * Which open overlay owns Escape (#8849). Several parts of the dashboard open overlays that can
 * coexist: the Add Provider modal card, plain confirmations (`.dialog-backdrop`), and native modal
 * `<dialog>`s. Escape belongs to the one the user sees on top:
 * - an open native modal dialog sits in the browser's top layer, above every in-page overlay, and
 *   the most recently opened one is on top;
 * - among in-page overlays, the higher computed z-index wins (`.dialog-backdrop` is 900,
 *   `.modal-overlay` uses --z-modal), and document order breaks ties.
 */
const OVERLAY_LAYERS = "dialog[open], .modal-overlay, .dialog-backdrop";

function zIndexOf(element: Element): number {
  const view = element.ownerDocument.defaultView;
  const value = view ? Number.parseInt(view.getComputedStyle(element).zIndex, 10) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
}

export function topmostOverlayLayer(): Element | undefined {
  const open = [...document.querySelectorAll(OVERLAY_LAYERS)]
    .filter(node => node.tagName !== "DIALOG" || (node as HTMLDialogElement).open);
  const dialogs = open.filter(node => node.tagName === "DIALOG");
  if (dialogs.length > 0) return dialogs[dialogs.length - 1];
  let top: Element | undefined;
  for (const node of open) if (!top || zIndexOf(node) >= zIndexOf(top)) top = node;
  return top;
}

/** True when `layer` is the overlay Escape belongs to. */
export function isTopmostOverlayLayer(layer: Element | null): boolean {
  return layer !== null && topmostOverlayLayer() === layer;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "iframe",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function collectFocusableElements(container: ParentNode | null): HTMLElement[] {
  if (!container) return [];
  const all = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const visible: HTMLElement[] = [];
  for (const el of all) {
    if (el.getAttribute("aria-hidden") === "true") continue;
    if (el.closest("[hidden], [inert], [aria-hidden='true']")) continue;
    visible.push(el);
  }
  return visible;
}

/**
 * Marks ancestors' siblings outside `overlay` as `inert` while active and wraps
 * Tab / focusin navigation strictly inside `dialog`. Returns a cleanup function.
 */
export function activateModalFocusTrap(overlay: HTMLElement, dialog: HTMLElement): () => void {
  const doc = overlay.ownerDocument;
  const view = doc.defaultView ?? window;
  const markedInert: HTMLElement[] = [];

  let cursor: HTMLElement | null = overlay;
  while (cursor && cursor !== doc.body) {
    const parent: HTMLElement | null = cursor.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === cursor || !("setAttribute" in sibling) || !("matches" in sibling)) continue;
      if (sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
      const el = sibling as HTMLElement;
      if (el.hasAttribute("inert") || el.inert) continue;
      if (el.matches(OVERLAY_LAYERS) || el.matches("[aria-live]") || el.querySelector(OVERLAY_LAYERS)) continue;
      el.inert = true;
      el.setAttribute("inert", "");
      markedInert.push(el);
    }
    cursor = parent;
  }

  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !isTopmostOverlayLayer(overlay)) return;
    const focusables = collectFocusableElements(dialog);
    if (focusables.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = doc.activeElement as HTMLElement | null;
    if (!active || !dialog.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const trapFocusIn = (e: FocusEvent) => {
    if (!isTopmostOverlayLayer(overlay)) return;
    const target = e.target as Node | null;
    if (target && dialog.contains(target)) return;
    const targetEl = target && "closest" in target ? (target as Element) : null;
    if (targetEl?.closest(OVERLAY_LAYERS)) return;
    const focusables = collectFocusableElements(dialog);
    (focusables[0] ?? dialog).focus();
  };

  view.addEventListener("keydown", trapTab, true);
  doc.addEventListener("focusin", trapFocusIn);

  return () => {
    view.removeEventListener("keydown", trapTab, true);
    doc.removeEventListener("focusin", trapFocusIn);
    for (const el of markedInert) {
      el.inert = false;
      el.removeAttribute("inert");
    }
  };
}
