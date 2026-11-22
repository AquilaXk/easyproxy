import type { ReactNode } from "react";

/*
 * Selected plate of a segmented track. Rendered with pure CSS transitions rather than a
 * runtime layout-animation library so controls stay instant without a multi-kilobyte
 * animation engine chunk.
 */

/** Wraps a segmented track group. */
export function SegmentThumbGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Render inside the selected option only. */
export function SegmentThumb(_props: { layoutId: string }) {
  return (
    <span
      aria-hidden
      className="absolute inset-0 rounded-[inherit] bg-raised shadow-sm ring-1 ring-line transition-opacity duration-150 motion-reduce:transition-none dark:bg-surface-2"
    />
  );
}
