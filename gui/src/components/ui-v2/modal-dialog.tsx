import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type DialogHTMLAttributes,
  type FormEventHandler,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { useT } from "../../i18n/shared";
import { cn } from "@/lib/utils";

const FOCUSABLE_IN_CARD =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isPointOutsideRect(rect: DOMRect, clientX: number, clientY: number): boolean {
  if (rect.width === 0 && rect.height === 0) return false;
  return clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
}

export interface ModalDialogProps extends Omit<DialogHTMLAttributes<HTMLDialogElement>, "onClose" | "onCancel" | "onSubmit"> {
  onClose: () => void;
  dismissDisabled?: boolean;
  backdropDismiss?: boolean;
  closeLabel?: string;
  surfaceTag?: "div" | "form";
  cardClassName?: string;
  cardStyle?: CSSProperties;
  cardRole?: string;
  ariaBusy?: boolean;
  noValidate?: boolean;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocus?: boolean;
  children: ReactNode;
}

export function ModalDialog({
  onClose,
  dismissDisabled = false,
  backdropDismiss = true,
  closeLabel,
  surfaceTag = "div",
  cardClassName,
  cardStyle,
  cardRole,
  ariaBusy,
  noValidate,
  onSubmit,
  initialFocusRef,
  restoreFocus = true,
  className,
  children,
  ...dialogProps
}: ModalDialogProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const pointerDownOutsideRef = useRef(false);
  const pointerDownInsideRef = useRef(false);
  const suppressBackdropClickRef = useRef(false);
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const clearSuppressTimer = useCallback(() => {
    if (suppressTimerRef.current !== undefined) {
      globalThis.clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = undefined;
    }
  }, []);

  const scheduleSuppressReset = useCallback(() => {
    clearSuppressTimer();
    suppressBackdropClickRef.current = true;
    suppressTimerRef.current = globalThis.setTimeout(() => {
      suppressBackdropClickRef.current = false;
      suppressTimerRef.current = undefined;
    }, 0);
  }, [clearSuppressTimer]);

  const requestClose = useCallback(() => {
    if (!dismissDisabled) onClose();
  }, [dismissDisabled, onClose]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute("open", "");
        }
      } else {
        dialog.setAttribute("open", "");
      }
    }

    const surface = surfaceRef.current;
    if (initialFocusRef?.current) {
      initialFocusRef.current.focus();
    } else if (surface && !surface.contains(document.activeElement)) {
      const target = surface.querySelector<HTMLElement>(FOCUSABLE_IN_CARD);
      (target ?? surface).focus();
    }

    return () => {
      clearSuppressTimer();
      if (dialog?.open) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
      const prev = previousFocusRef.current;
      if (restoreFocus && prev && prev.isConnected && typeof prev.focus === "function") {
        prev.focus();
      }
    };
  }, [clearSuppressTimer, initialFocusRef, restoreFocus]);

  const handleCancel = useCallback((event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    requestClose();
  }, [requestClose]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    }
  }, [requestClose]);

  const resolvedCloseLabel = closeLabel ?? t("common.close");
  const cardClasses = cn("modal-card", cardClassName);

  const surfaceProps = {
    className: cardClasses,
    style: cardStyle,
    role: cardRole ?? (surfaceTag === "div" ? "document" : undefined),
    tabIndex: -1,
    "aria-busy": ariaBusy,
    onClick: (event: SyntheticEvent) => event.stopPropagation(),
  };

  return (
    <dialog
      role="dialog"
      {...dialogProps}
      ref={dialogRef}
      className={cn("modal-overlay", className)}
      onCancel={handleCancel}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        clearSuppressTimer();
        suppressBackdropClickRef.current = false;
        if (!backdropDismiss || dismissDisabled || !surfaceRef.current) {
          pointerDownOutsideRef.current = false;
          pointerDownInsideRef.current = false;
          return;
        }
        const outside = isPointOutsideRect(
          surfaceRef.current.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        );
        pointerDownOutsideRef.current = outside;
        pointerDownInsideRef.current = !outside;
      }}
      onPointerUp={(event) => {
        const downOutside = pointerDownOutsideRef.current;
        const downInside = pointerDownInsideRef.current;
        pointerDownOutsideRef.current = false;
        pointerDownInsideRef.current = false;
        if (!backdropDismiss || dismissDisabled || !surfaceRef.current) return;
        if (downOutside && isPointOutsideRect(surfaceRef.current.getBoundingClientRect(), event.clientX, event.clientY)) {
          scheduleSuppressReset();
          requestClose();
        } else if (downInside) {
          scheduleSuppressReset();
        }
      }}
    >
      {backdropDismiss && (
        <button
          type="button"
          className="modal-backdrop-dismiss"
          aria-label={resolvedCloseLabel}
          tabIndex={-1}
          disabled={dismissDisabled}
          onClick={() => {
            if (suppressBackdropClickRef.current) {
              suppressBackdropClickRef.current = false;
              clearSuppressTimer();
              return;
            }
            requestClose();
          }}
        />
      )}
      {surfaceTag === "form" ? (
        <form
          {...surfaceProps}
          ref={surfaceRef as RefObject<HTMLFormElement>}
          noValidate={noValidate}
          onSubmit={onSubmit}
        >
          {children}
        </form>
      ) : (
        <div
          {...surfaceProps}
          ref={surfaceRef as RefObject<HTMLDivElement>}
        >
          {children}
        </div>
      )}
    </dialog>
  );
}
