import { type ReactNode } from "react";
import { IconPower, IconRefresh, IconX } from "../../icons";
import { cn } from "@/lib/utils";

interface ProxyControlsProps {
  /** Card title, e.g. "Proxy". */
  label: string;
  /** Status next to the live dot, e.g. "Online". */
  statusLabel: string;
  /** Optional second half of the status line, e.g. how long the proxy has been up. */
  detail?: string | undefined;
  /** False when the proxy is not answering (health check failed): the status dot goes neutral. Default true. */
  online?: boolean | undefined;
  stopLabel: string;
  stoppingLabel: string;
  restartLabel: string;
  restartingLabel: string;
  stopping: boolean;
  restarting: boolean;
  onStop: () => void | Promise<unknown>;
  onRestart: () => void;
  /** Optional action to end the dashboard session on a connected client. */
  session?: { label: string; busyLabel: string; busy: boolean; onClick: () => void } | undefined;
  className?: string;
}

/*
 * Design system v2 proxy status row: a quiet status dot, label + uptime telemetry, and
 * explicit icon buttons for reloading Codex or stopping the proxy. No skeuomorphic drag
 * mechanics or ambient animations.
 */
export function ProxyControls({
  label,
  statusLabel,
  detail,
  online = true,
  stopLabel,
  stoppingLabel,
  restartLabel,
  restartingLabel,
  stopping,
  restarting,
  onStop,
  onRestart,
  session,
  className,
}: ProxyControlsProps) {
  const live = online && !stopping;
  const status = stopping ? stoppingLabel : restarting ? restartingLabel : statusLabel;
  const busy = stopping || restarting;

  return (
    <div
      className={cn("ui-v2 relative flex h-8 items-center gap-1.5 overflow-hidden px-2", className)}
      title={detail ? `${status} · ${detail}` : status}
    >
      <span className="relative flex min-w-0 flex-1 items-center gap-1.5">
        <span className="grid size-3 shrink-0 place-items-center" aria-hidden>
          <span
            className={cn(
              "size-2 rounded-full transition-colors duration-300",
              stopping ? "bg-danger" : live ? "bg-success" : "bg-fg-subtle",
            )}
          />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1 text-[13px] leading-5">
          <span className="shrink-0 font-medium text-fg">{label}</span>
          <span className="sr-only">{status}</span>
          <span
            className={cn(
              "min-w-0 truncate text-xs tabular-nums",
              stopping ? "font-medium text-danger" : restarting ? "font-medium text-highlight" : "text-fg-subtle",
            )}
            aria-hidden={!busy && !!detail ? undefined : true}
          >
            {busy ? status : detail ?? statusLabel}
          </span>
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        {session && (
          <TrayButton
            onClick={session.onClick}
            disabled={session.busy}
            label={session.busy ? session.busyLabel : session.label}
            title={session.label}
          >
            <IconX />
          </TrayButton>
        )}
        <TrayButton
          onClick={onRestart}
          disabled={restarting || stopping}
          label={restarting ? restartingLabel : restartLabel}
          title={restarting ? restartingLabel : restartLabel}
          iconClassName={restarting ? "animate-spin" : undefined}
        >
          <IconRefresh />
        </TrayButton>
        <span className="mx-0.5 h-3.5 w-px bg-line" aria-hidden />
        <TrayButton
          onClick={() => { void onStop(); }}
          disabled={stopping}
          label={stopping ? stoppingLabel : stopLabel}
          title={stopping ? stoppingLabel : stopLabel}
          tone="danger"
        >
          <IconPower />
        </TrayButton>
      </div>
    </div>
  );
}

function TrayButton({
  onClick,
  disabled,
  label,
  title,
  tone = "default",
  iconClassName,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  title: string;
  tone?: "default" | "danger";
  iconClassName?: string | undefined;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className={cn(
        "inline-flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] bg-transparent text-fg-subtle",
        "transition-[background-color,color] duration-150 ease-soft",
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-highlight",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5",
        tone === "danger"
          ? "hover:bg-danger-soft hover:text-danger"
          : "hover:bg-accent-soft hover:text-fg",
        iconClassName && `[&_svg]:${iconClassName}`,
      )}
    >
      {children}
    </button>
  );
}
