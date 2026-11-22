import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A Windows home for Remote Link census tests (#8359): a Desktop epx.exe that is really this bun.exe (so it reports
 * Bun's version, never an EasyProxy one), and an npm-style CLI entry this bun.exe runs as the served [bun.exe, entry]
 * pair. The entry answers --version with `version` and otherwise prints its arguments and stdin as JSON.
 * `track` receives the temporary root so the caller's cleanup owns it.
 */
export function windowsServedHome(track: (root: string) => void, version = "2.99.0") {
  const home = mkdtempSync(join(tmpdir(), "epx-windows-served-"));
  track(home);
  const desktop = join(home, ".easyproxy-desktop", "bin", "epx.exe");
  mkdirSync(dirname(desktop), { recursive: true });
  copyFileSync(process.execPath, desktop);
  const entry = join(home, "npm prefix", "node_modules", "easyproxy", "src", "cli", "index.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, [
    `if (process.argv[2] === "--version") { console.log("easyproxy ${version}"); process.exit(0); }`,
    "console.log(JSON.stringify({ served: true, args: process.argv.slice(2), input: await Bun.stdin.text() }));",
  ].join("\n"));
  const epxHome = join(home, ".easyproxy");
  mkdirSync(epxHome, { recursive: true });
  const census = (body: unknown) => writeFileSync(join(epxHome, "serving-runtimes.json"), JSON.stringify(body, null, 2) + "\n");
  const run = async (argv: string[], env: Record<string, string | undefined> = { USERPROFILE: home, HOME: home, EASYPROXY_HOME: epxHome }) => {
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
    for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
    const child = Bun.spawn(argv, {
      env: childEnv,
      stdin: new Blob(["fixture-key-stdin"]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  return { home, entry, epxHome, census, run };
}
