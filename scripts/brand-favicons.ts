#!/usr/bin/env bun
/**
 * Render the favicons the dashboard and the documentation site serve from the brand mark vector.
 *
 * They used to be hand-made bitmaps with no source, and one of them was wrong in a way the file
 * itself does not show: docs-site/public/favicon.png was the dark variant of the mark, white on
 * transparency, so on a light browser tab strip the documentation site's favicon was white on
 * white. The source is now the brand mark itself (scripts/brand/easyproxy-mark.svg): an ice-blue
 * to lavender forward routing chevron paired with a violet trailing prism, drawn on transparency
 * with no backdrop tile so it reads on both light and dark tab strips. Browsers that support SVG
 * favicons use the vector link each site declares first; these PNG/ICO files are the fallback.
 *
 * Sizes and names here are the ones gui/index.html and docs-site/astro.config.mjs already
 * reference, so nothing on either site has to change to pick these up.
 *
 * --check regenerates into a temporary directory and compares byte for byte, the same contract
 * desktop/scripts/generate-icons.ts has for the app icon set.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIco, render } from "./lib/icon-render";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repoRoot, "scripts", "brand", "easyproxy-mark.svg");

/** Verbatim copies of scripts/brand/easyproxy-mark.svg served directly by the GUI and docs site. */
const SVG_COPIES = [
  "gui/public/favicon.svg",
  "docs-site/public/favicon.svg",
  "docs-site/src/assets/logo-light.svg",
] as const;

/** Favicon PNGs the two sites reference, by path relative to the repository root. */
const FAVICON_SIZES: Record<string, number> = {
  "gui/public/favicon.png": 128,
  "docs-site/public/favicon.png": 192,
};

/** 512px transparent brand rasters rendered from the same vector for the GUI and tray surfaces. */
const BRAND_RASTER_SIZES: Record<string, number> = {
  "gui/public/logo.png": 512,
  "src/tray/assets/easyproxy-tray.png": 512,
};

/** The documentation site's .ico, which Starlight names directly, and the sizes it carries. */
const ICO_OUTPUT = "docs-site/public/favicon.ico";
const ICO_SIZES = [16, 32, 48];

/** Scratch files are flat, so a nested output name becomes one path segment. */
function scratchName(output: string): string {
  return output.replaceAll("/", "__");
}

function generateInto(target: string): string[] {
  const produced: string[] = [];
  const markSvg = readFileSync(source);
  for (const output of SVG_COPIES) {
    writeFileSync(join(target, scratchName(output)), markSvg);
    produced.push(output);
  }

  const renderedBySize = new Map<number, Buffer>();
  for (const [output, size] of Object.entries({ ...FAVICON_SIZES, ...BRAND_RASTER_SIZES })) {
    const outPath = join(target, scratchName(output));
    const cached = renderedBySize.get(size);
    if (cached) {
      writeFileSync(outPath, cached);
    } else {
      render(size, outPath, source);
      renderedBySize.set(size, readFileSync(outPath));
    }
    produced.push(output);
  }

  const parts: Array<{ size: number; bytes: Buffer }> = [];
  for (const size of ICO_SIZES) {
    const scratch = join(target, `.ico-${size}.png`);
    render(size, scratch, source);
    parts.push({ size, bytes: readFileSync(scratch) });
    rmSync(scratch, { force: true });
  }
  writeFileSync(join(target, scratchName(ICO_OUTPUT)), buildIco(parts));
  produced.push(ICO_OUTPUT);

  return produced;
}

function main(): number {
  if (!existsSync(source)) {
    console.error(`[favicons] missing source: ${source}`);
    return 1;
  }
  const check = process.argv.includes("--check");
  const scratch = mkdtempSync(join(tmpdir(), "epx-favicons-"));
  try {
    const produced = generateInto(scratch);
    if (!check) {
      // Written in one pass at the end, so a renderer failure part way through cannot leave one
      // site on the new mark and the other on the old one.
      for (const output of produced) {
        writeFileSync(join(repoRoot, output), readFileSync(join(scratch, scratchName(output))));
      }
      console.log(`[favicons] regenerated ${produced.length} favicons from ${basename(source)}`);
      return 0;
    }

    const drifted = produced.filter(output => {
      const committed = join(repoRoot, output);
      if (!existsSync(committed)) return true;
      return !readFileSync(join(scratch, scratchName(output))).equals(readFileSync(committed));
    });
    if (drifted.length > 0) {
      console.error(`[favicons] these do not match the app icon vector: ${drifted.join(", ")}`);
      console.error("[favicons] regenerate with: bun run favicons");
      return 1;
    }
    console.log(`[favicons] ${produced.length} favicons match the source`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exit(main());

