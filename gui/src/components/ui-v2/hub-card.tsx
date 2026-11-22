import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type HubBadge = { tone: "done" | "todo" | "optional"; label: string };

interface HubCardProps {
  title: string;
  /** The original product term, shown small so docs and CLI names still connect. */
  term?: string | undefined;
  body: ReactNode;
  badge?: HubBadge | undefined;
  icon?: ReactNode;
  onOpen: () => void;
  openLabel: string;
}

const BADGE_TONE: Record<HubBadge["tone"], string> = {
  done: "bg-success-soft text-success",
  todo: "bg-highlight-soft text-highlight",
  optional: "bg-surface-2 text-fg-muted",
};

/*
 * Design system v2 hub card: a borderless surface that is one big button. The arrow and
 * the lift on hover say "this opens somewhere"; the badge carries state, never colour alone.
 */
export function HubCard({ title, term, body, badge, icon, onOpen, openLabel }: HubCardProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${title} — ${openLabel}`}
      className={cn(
        "ui-v2 group row-span-2 grid h-full w-full cursor-pointer grid-rows-subgrid items-start gap-2.5 rounded-card bg-surface p-4 text-left ring-1 ring-inset ring-line",
        "transition-[translate,box-shadow,background-color] duration-300 ease-soft hover:-translate-y-0.5 hover:bg-raised hover:shadow-md hover:ring-line-strong",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight",
      )}
    >
      <span className="flex items-center gap-3">
        {icon && (
          <span className="grid size-8 shrink-0 place-items-center rounded-control bg-raised text-fg shadow-sm ring-1 ring-line transition-colors group-hover:bg-accent-soft group-hover:text-accent [&_svg]:size-4">
            {icon}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] leading-5 font-semibold tracking-[-0.01em] text-fg">{title}</span>
          {term && <span className="truncate font-sans text-xs text-fg-subtle">{term}</span>}
        </span>
        {badge && <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold", BADGE_TONE[badge.tone])}>{badge.label}</span>}
        <span aria-hidden className="shrink-0 text-[13px] text-fg-subtle transition-[transform,color] duration-300 ease-soft group-hover:translate-x-0.5 group-hover:text-highlight">→</span>
      </span>
      <span className="text-[13px] leading-5 text-fg-muted">{body}</span>
    </button>
  );
}
