import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { I18nContext, getActiveLocale } from "../../i18n/shared";
import { uxT } from "../../i18n/ux-overhaul-copy";

export interface ComboboxOption {
  value: string;
  label?: string;
  detail?: string;
}

export interface ComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (string | ComboboxOption)[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  inputClassName?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  maxOptions?: number;
}

function normalizeOptions(options: readonly (string | ComboboxOption)[]): ComboboxOption[] {
  const seen = new Set<string>();
  const out: ComboboxOption[] = [];
  for (const item of options) {
    const opt = typeof item === "string" ? { value: item } : item;
    if (!opt.value || seen.has(opt.value)) continue;
    seen.add(opt.value);
    out.push(opt);
  }
  return out;
}

/**
 * Accessible editable combobox following the WAI-ARIA 1.2 list-autocomplete pattern.
 * Stops Escape propagation while open so parent modal/dialog Escape handlers stay open.
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  required = false,
  className,
  inputClassName,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  maxOptions = 80,
}: ComboboxProps) {
  const i18n = useContext(I18nContext);
  const locale = i18n?.locale ?? getActiveLocale();
  const defaultInputId = useId();
  const listboxId = useId();
  const optionIdPrefix = useId();
  const inputId = id ?? defaultInputId;
  const rootRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [filterActive, setFilterActive] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const normalized = useMemo(() => normalizeOptions(options), [options]);

  const filtered = useMemo(() => {
    const query = filterActive ? value.trim().toLowerCase() : "";
    const out: ComboboxOption[] = [];
    for (const opt of normalized) {
      if (query) {
        const hay = `${opt.value}\0${opt.label ?? ""}\0${opt.detail ?? ""}`.toLowerCase();
        if (!hay.includes(query)) continue;
      }
      out.push(opt);
      if (out.length >= maxOptions) break;
    }
    return out;
  }, [normalized, value, filterActive, maxOptions]);

  const showPopup = open && !disabled && (filtered.length > 0 || (filterActive && normalized.length > 0));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        setOpen(false);
        setFilterActive(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const selectOption = useCallback((nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
    setFilterActive(false);
    setActiveIndex(-1);
  }, [onChange]);

  const activeOptionId = showPopup && activeIndex >= 0 && activeIndex < filtered.length
    ? optionIdPrefix + String(activeIndex)
    : undefined;

  return (
    <div ref={rootRef} className={cn("relative w-full min-w-0", className)}>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showPopup}
        aria-controls={showPopup ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        autoComplete="off"
        spellCheck={false}
        required={required}
        disabled={disabled}
        className={cn("input w-full", inputClassName)}
        placeholder={placeholder}
        value={value}
        onFocus={() => {
          if (disabled || normalized.length === 0) return;
          setFilterActive(false);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onClick={() => {
          if (disabled || normalized.length === 0) return;
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
          setFilterActive(false);
          setActiveIndex(-1);
        }}
        onChange={e => {
          onChange(e.target.value);
          setFilterActive(true);
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={e => {
          if (disabled) return;
          if (e.key === "ArrowDown") {
            if (normalized.length === 0) return;
            e.preventDefault();
            if (!open) {
              setOpen(true);
              setActiveIndex(0);
              return;
            }
            if (filtered.length > 0) {
              setActiveIndex(prev => (prev + 1) % filtered.length);
            }
            return;
          }
          if (e.key === "ArrowUp") {
            if (normalized.length === 0) return;
            e.preventDefault();
            if (!open) {
              setOpen(true);
              setActiveIndex(Math.max(0, filtered.length - 1));
              return;
            }
            if (filtered.length > 0) {
              setActiveIndex(prev => (prev <= 0 ? filtered.length - 1 : prev - 1));
            }
            return;
          }
          if (e.key === "Enter" && showPopup && activeIndex >= 0 && activeIndex < filtered.length) {
            e.preventDefault();
            selectOption(filtered[activeIndex]!.value);
            return;
          }
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            e.nativeEvent?.stopPropagation?.();
            e.nativeEvent?.stopImmediatePropagation?.();
            setOpen(false);
            setFilterActive(false);
            setActiveIndex(-1);
            return;
          }
          if (e.key === "Tab" && open) {
            setOpen(false);
            setFilterActive(false);
            setActiveIndex(-1);
          }
        }}
      />
      {showPopup && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 m-0 max-h-60 list-none overflow-y-auto rounded-panel border border-solid border-line-strong bg-raised p-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <li
              role="presentation"
              className="px-2.5 py-2 text-[12px] text-fg-muted"
            >
              {uxT(locale, "combobox.empty")}
            </li>
          ) : (
            filtered.map((opt, idx) => {
              const selected = opt.value === value;
              const active = idx === activeIndex;
              return (
                <li
                  key={opt.value}
                  id={optionIdPrefix + String(idx)}
                  role="option"
                  aria-selected={selected}
                  onMouseDown={e => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => selectOption(opt.value)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2.5 py-1.5 text-[12.5px] leading-5 transition-colors",
                    active
                      ? "bg-accent-soft text-fg"
                      : "text-fg hover:bg-accent-soft",
                    selected && "font-medium text-highlight",
                  )}
                >
                  <span className="min-w-0 truncate font-mono">{opt.label ?? opt.value}</span>
                  {opt.detail && (
                    <span className="shrink-0 text-[11px] text-fg-muted">{opt.detail}</span>
                  )}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
