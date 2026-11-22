/**
 * Sidebar footer row: the GitHub link plus circular satellite buttons.
 *
 * Update: always present, so "am I current?" is answerable at any time. It reads the
 * cached badge endpoint (no npm spawn per poll) purely to decide emphasis — an
 * available update renders the accent state plus a dot, otherwise it is a plain orb.
 * Either way a click opens the desktop update page in the app shell, or runs a fresh
 * package check in a browser dashboard where the existing dialog owns installation.
 */
import { useKeyedClientResource } from "../client-resource";
import { IconDownload, IconGithub, IconTerminal } from "../icons";
import { useT } from "../i18n/shared";
import { isDesktopShell, updateBadgeUrl } from "../lib/desktop-shell";

interface UpdateBadge {
  updateAvailable?: boolean;
  latestVersion?: string | null;
  installer?: "bun" | "mise" | "npm" | "pnpm" | "source" | "desktop";
  /** True when no cached registry answer exists, so "no update" is unproven. */
  unknown?: boolean;
}

const BADGE_POLL_MS = 10 * 60_000;
const REPO_URL = "https://github.com/AquilaXk/easyproxy";

async function readJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return await res.json() as T;
}

export function SidebarGithubRow({
  apiBase,
  onOpenUpdate,
  onOpenTerminalCommand,
}: {
  apiBase: string;
  /** Opens desktop updates in the app shell, or the package update surface in a browser. */
  onOpenUpdate: () => void;
  /** Opens the local terminal-command settings in the desktop app shell. */
  onOpenTerminalCommand: () => void;
}) {
  const t = useT();
  const badgeUrl = updateBadgeUrl(apiBase);
  const badgePoll = useKeyedClientResource(
    "sidebar-update-badge:" + badgeUrl,
    [badgeUrl],
    (signal) => readJson<UpdateBadge>(badgeUrl, signal),
    { pollMs: isDesktopShell() ? 60_000 : BADGE_POLL_MS },
  );

  const badge = badgePoll.data;
  const updateAvailable = badge?.updateAvailable === true;
  const latestVersion = badge?.latestVersion ?? null;

  // With an update pending the label names the version; otherwise it describes the
  // action, so the button never reads as "update available" when nothing is waiting.
  const updateLabel = updateAvailable && latestVersion
    ? t("sidebar.updateAvailable", { version: latestVersion })
    : isDesktopShell() ? t("sidebar.desktopUpdate") : t("sidebar.checkUpdate");

  return (
    <div className="sidebar-github-row">
      <a className="sidebar-link sidebar-github-link" href={REPO_URL} target="_blank" rel="noreferrer">
        <IconGithub /> {t("common.github")}
      </a>
      <div className="sidebar-github-actions">
        <button
          type="button"
          className={`sidebar-orb${updateAvailable ? " sidebar-orb--update" : ""}`}
          onClick={onOpenUpdate}
          aria-label={updateLabel}
          title={updateLabel}
        >
          <IconDownload aria-hidden="true" />
          {updateAvailable && <span className="sidebar-orb-dot" aria-hidden="true" />}
        </button>
        {isDesktopShell() && (
          <button
            type="button"
            className="sidebar-orb"
            onClick={onOpenTerminalCommand}
            aria-label={t("sidebar.terminalCommand")}
            title={t("sidebar.terminalCommand")}
          >
            <IconTerminal aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
