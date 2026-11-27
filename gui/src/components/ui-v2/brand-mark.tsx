import { useId } from "react";
import { cn } from "@/lib/utils";

interface BrandMarkProps {
  className?: string;
  /** Accessible name; omit when a visible wordmark sits next to the mark. */
  label?: string;
}

/*
 * The easyproxy gateway mark: an ice-blue to lavender forward routing chevron paired
 * with a luminous violet trailing prism on a transparent background.
 * Gradient, blur filter, and clipPath IDs are namespaced per mount with `useId()` so
 * multiple sidebar/topbar/drawer instances never collide in one document.
 */
export function BrandMark({ className, label }: BrandMarkProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (name: string) => `${uid}-${name}`;

  return (
    <svg
      viewBox="0 0 1024 1024"
      fill="none"
      className={cn("shrink-0", className)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true, focusable: "false" })}
    >
      <defs>
        <filter id={id("blur-28")} filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><feGaussianBlur stdDeviation="43.68" /></filter>
        <filter id={id("blur-16")} filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><feGaussianBlur stdDeviation="24.96" /></filter>
        <filter id={id("blur-4")} filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><feGaussianBlur stdDeviation="6.24" /></filter>
        <filter id={id("blur-1")} filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><feGaussianBlur stdDeviation="1.4" /></filter>

        <clipPath id={id("clip-purple")}>
          <path d="M 400.33 327.33 A 37.44 37.44 0 0 1 419.25 294.79 L 510.6 242.81 A 94.65 94.65 0 0 1 612.27 247.94 L 911.73 460.91 A 71.06 71.06 0 0 1 941.6 518.82 L 941.6 553.29 A 69.28 69.28 0 0 1 911.29 610.58 L 611.29 814.64 A 91.49 91.49 0 0 1 509.09 815.11 L 415.62 752.8 A 34.32 34.32 0 0 1 400.33 724.25 Z" />
        </clipPath>
        <clipPath id={id("clip-chevron")}>
          <path d="M 88.33 176.6 A 73.46 73.46 0 0 1 204.39 116.74 L 608.26 404.13 A 129.23 129.23 0 0 1 606.39 616.02 L 180.49 907.88 A 62.67 62.67 0 0 1 82.4 856.18 L 82.4 725.05 A 72.6 72.6 0 0 1 117.95 662.6 L 322.45 541.25 A 31.2 31.2 0 0 0 324.54 488.94 L 120.43 344.61 A 75.94 75.94 0 0 1 88.33 282.6 Z" />
        </clipPath>
        <clipPath id={id("clip-outside-chevron")}>
          <path clipRule="evenodd" fillRule="evenodd" d="M 0 0 H 1024 V 1024 H 0 Z M 88.33 176.6 A 73.46 73.46 0 0 1 204.39 116.74 L 608.26 404.13 A 129.23 129.23 0 0 1 606.39 616.02 L 180.49 907.88 A 62.67 62.67 0 0 1 82.4 856.18 L 82.4 725.05 A 72.6 72.6 0 0 1 117.95 662.6 L 322.45 541.25 A 31.2 31.2 0 0 0 324.54 488.94 L 120.43 344.61 A 75.94 75.94 0 0 1 88.33 282.6 Z" />
        </clipPath>

        <linearGradient id={id("purple-base")} x1="509.68" y1="246.8" x2="759.28" y2="816.2" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#a78de6" />
          <stop offset="38%" stopColor="#8e72cf" />
          <stop offset="70%" stopColor="#866bc7" />
          <stop offset="100%" stopColor="#bf98ed" />
        </linearGradient>

        <radialGradient id={id("purple-bot-glow")} cx="595.48" cy="813.08" r="382.2" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#e2bef8" stopOpacity="0.74" />
          <stop offset="50%" stopColor="#caa7f0" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#967cce" stopOpacity="0" />
        </radialGradient>

        <radialGradient id={id("purple-soft-core")} cx="767.08" cy="504.2" r="221.52" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#725aad" stopOpacity="0.50" />
          <stop offset="100%" stopColor="#7c66b5" stopOpacity="0" />
        </radialGradient>

        <linearGradient id={id("purple-fresnel")} x1="494.08" y1="231.2" x2="884.08" y2="824" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#dfd0fb" />
          <stop offset="45%" stopColor="#cbb4f5" />
          <stop offset="75%" stopColor="#dcc0fa" />
          <stop offset="100%" stopColor="#eed6ff" />
        </linearGradient>

        <linearGradient id={id("purple-spec")} x1="501.88" y1="229.64" x2="899.68" y2="831.8" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#efe4ff" />
          <stop offset="40%" stopColor="#dfcafa" />
          <stop offset="72%" stopColor="#e9d2fd" />
          <stop offset="100%" stopColor="#f4e4ff" />
        </linearGradient>

        <linearGradient id={id("chev-base")} x1="88.48" y1="519.8" x2="662.56" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#65a7e6" />
          <stop offset="32%" stopColor="#5895d9" />
          <stop offset="58%" stopColor="#6f97df" />
          <stop offset="82%" stopColor="#9394ea" />
          <stop offset="95%" stopColor="#ae9ff1" />
          <stop offset="100%" stopColor="#c1aef6" />
        </linearGradient>

        <radialGradient id={id("chev-nose-glow")} cx="634.48" cy="512" r="234" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ded4ff" stopOpacity="0.50" />
          <stop offset="55%" stopColor="#b5adf2" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#6fa6df" stopOpacity="0" />
        </radialGradient>

        <linearGradient id={id("chev-fresnel")} x1="85.36" y1="519.8" x2="662.56" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#bce0ff" />
          <stop offset="46%" stopColor="#a6d4fb" />
          <stop offset="74%" stopColor="#bdd0fc" />
          <stop offset="90%" stopColor="#d4c9fc" />
          <stop offset="100%" stopColor="#eae2ff" />
        </linearGradient>

        <linearGradient id={id("chev-rim-tight")} x1="85.36" y1="519.8" x2="662.56" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#d4ecff" />
          <stop offset="50%" stopColor="#c4e4ff" />
          <stop offset="76%" stopColor="#d6dffe" />
          <stop offset="100%" stopColor="#f0eaff" />
        </linearGradient>

        <linearGradient id={id("chev-spec")} x1="85.36" y1="137.6" x2="662.56" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#e5f4ff" />
          <stop offset="48%" stopColor="#d6ecff" />
          <stop offset="78%" stopColor="#e2e5fe" />
          <stop offset="100%" stopColor="#efe7fe" />
        </linearGradient>
      </defs>

      <g clipPath={`url(#${id("clip-outside-chevron")})`}>
        <g clipPath={`url(#${id("clip-purple")})`}>
          <rect x="0" y="0" width="1024" height="1024" fill={`url(#${id("purple-base")})`} />
          <rect x="0" y="0" width="1024" height="1024" fill={`url(#${id("purple-bot-glow")})`} />
          <rect x="0" y="0" width="1024" height="1024" fill={`url(#${id("purple-soft-core")})`} />
          <ellipse cx="653.2" cy="522.92" rx="81.12" ry="163.8" fill="#d2b8f9" opacity="0.38" filter={`url(#${id("blur-28")})`} />
          <path d="M 408.28 750.68 L 559.6 834.92 L 938.68 582.2" fill="none" stroke="#e5c6fc" strokeWidth="43.68" opacity="0.48" filter={`url(#${id("blur-16")})`} />
          <path d="M 400.33 327.33 A 37.44 37.44 0 0 1 419.25 294.79 L 510.6 242.81 A 94.65 94.65 0 0 1 612.27 247.94 L 911.73 460.91 A 71.06 71.06 0 0 1 941.6 518.82 L 941.6 553.29 A 69.28 69.28 0 0 1 911.29 610.58 L 611.29 814.64 A 91.49 91.49 0 0 1 509.09 815.11 L 415.62 752.8 A 34.32 34.32 0 0 1 400.33 724.25 Z" fill="none" stroke={`url(#${id("purple-fresnel")})`} strokeWidth="37.44" opacity="0.52" filter={`url(#${id("blur-16")})`} />
          <path d="M 400.33 327.33 A 37.44 37.44 0 0 1 419.25 294.79 L 510.6 242.81 A 94.65 94.65 0 0 1 612.27 247.94 L 911.73 460.91 A 71.06 71.06 0 0 1 941.6 518.82 L 941.6 553.29 A 69.28 69.28 0 0 1 911.29 610.58 L 611.29 814.64 A 91.49 91.49 0 0 1 509.09 815.11 L 415.62 752.8 A 34.32 34.32 0 0 1 400.33 724.25 Z" fill="none" stroke={`url(#${id("purple-fresnel")})`} strokeWidth="12.48" opacity="0.62" filter={`url(#${id("blur-4")})`} />
          <path d="M 400.33 327.33 A 37.44 37.44 0 0 1 419.25 294.79 L 510.6 242.81 A 94.65 94.65 0 0 1 612.27 247.94 L 911.73 460.91 A 71.06 71.06 0 0 1 941.6 518.82 L 941.6 553.29 A 69.28 69.28 0 0 1 911.29 610.58 L 611.29 814.64 A 91.49 91.49 0 0 1 509.09 815.11 L 415.62 752.8 A 34.32 34.32 0 0 1 400.33 724.25 Z" fill="none" stroke={`url(#${id("purple-spec")})`} strokeWidth="4.06" opacity="0.82" filter={`url(#${id("blur-1")})`} />
        </g>
        <path d="M 400.33 327.33 A 37.44 37.44 0 0 1 419.25 294.79 L 510.6 242.81 A 94.65 94.65 0 0 1 612.27 247.94 L 911.73 460.91 A 71.06 71.06 0 0 1 941.6 518.82 L 941.6 553.29 A 69.28 69.28 0 0 1 911.29 610.58 L 611.29 814.64 A 91.49 91.49 0 0 1 509.09 815.11 L 415.62 752.8 A 34.32 34.32 0 0 1 400.33 724.25 Z" fill="none" stroke={`url(#${id("purple-spec")})`} strokeWidth="2.18" strokeOpacity="0.72" />
      </g>

      <g clipPath={`url(#${id("clip-chevron")})`}>
        <rect x="0" y="0" width="1024" height="1024" fill={`url(#${id("chev-base")})`} />
        <rect x="0" y="0" width="1024" height="1024" fill={`url(#${id("chev-nose-glow")})`} />
        <ellipse cx="267.88" cy="295.16" rx="143.52" ry="71.76" transform="rotate(35 267.88 295.16)" fill="#588cc8" opacity="0.44" filter={`url(#${id("blur-16")})`} />
        <ellipse cx="263.2" cy="710.12" rx="146.64" ry="71.76" transform="rotate(-32 263.2 710.12)" fill="#5488c6" opacity="0.44" filter={`url(#${id("blur-16")})`} />
        <ellipse cx="490.96" cy="513.56" rx="90.48" ry="106.08" fill="#747ed0" opacity="0.36" filter={`url(#${id("blur-28")})`} />
        <path d="M 100.96 317 L 359.92 516.68 L 94.72 691.4" fill="none" stroke="#b8e0ff" strokeWidth="46.8" opacity="0.58" filter={`url(#${id("blur-16")})`} />
        <path d="M 104.08 912.92 L 486.28 672.68" fill="none" stroke="#b4dcff" strokeWidth="40.56" opacity="0.52" filter={`url(#${id("blur-16")})`} />
        <path d="M 88.33 176.6 A 73.46 73.46 0 0 1 204.39 116.74 L 608.26 404.13 A 129.23 129.23 0 0 1 606.39 616.02 L 180.49 907.88 A 62.67 62.67 0 0 1 82.4 856.18 L 82.4 725.05 A 72.6 72.6 0 0 1 117.95 662.6 L 322.45 541.25 A 31.2 31.2 0 0 0 324.54 488.94 L 120.43 344.61 A 75.94 75.94 0 0 1 88.33 282.6 Z" fill="none" stroke={`url(#${id("chev-fresnel")})`} strokeWidth="34.32" opacity="0.62" filter={`url(#${id("blur-16")})`} />
        <path d="M 88.33 176.6 A 73.46 73.46 0 0 1 204.39 116.74 L 608.26 404.13 A 129.23 129.23 0 0 1 606.39 616.02 L 180.49 907.88 A 62.67 62.67 0 0 1 82.4 856.18 L 82.4 725.05 A 72.6 72.6 0 0 1 117.95 662.6 L 322.45 541.25 A 31.2 31.2 0 0 0 324.54 488.94 L 120.43 344.61 A 75.94 75.94 0 0 1 88.33 282.6 Z" fill="none" stroke={`url(#${id("chev-rim-tight")})`} strokeWidth="11.7" opacity="0.68" filter={`url(#${id("blur-4")})`} />
        <path d="M 88.33 176.6 A 73.46 73.46 0 0 1 204.39 116.74 L 608.26 404.13 A 129.23 129.23 0 0 1 606.39 616.02 L 180.49 907.88 A 62.67 62.67 0 0 1 82.4 856.18 L 82.4 725.05 A 72.6 72.6 0 0 1 117.95 662.6 L 322.45 541.25 A 31.2 31.2 0 0 0 324.54 488.94 L 120.43 344.61 A 75.94 75.94 0 0 1 88.33 282.6 Z" fill="none" stroke={`url(#${id("chev-spec")})`} strokeWidth="3.9" opacity="0.84" filter={`url(#${id("blur-1")})`} />
      </g>
      <path d="M 88.33 176.6 A 73.46 73.46 0 0 1 204.39 116.74 L 608.26 404.13 A 129.23 129.23 0 0 1 606.39 616.02 L 180.49 907.88 A 62.67 62.67 0 0 1 82.4 856.18 L 82.4 725.05 A 72.6 72.6 0 0 1 117.95 662.6 L 322.45 541.25 A 31.2 31.2 0 0 0 324.54 488.94 L 120.43 344.61 A 75.94 75.94 0 0 1 88.33 282.6 Z" fill="none" stroke={`url(#${id("chev-spec")})`} strokeWidth="2.18" strokeOpacity="0.74" />
    </svg>
  );
}
