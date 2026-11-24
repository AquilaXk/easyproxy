import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { withConfigDirHardeningSettled } from "../config/paths";
import { withIntegrationWriterLock } from "../integrations/writer-lock";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import {
  EcosystemSyncError,
  MAX_ECOSYSTEM_CONFIG_BYTES,
  readBoundedNonSymlinkFile,
  type EcosystemCliId,
  type EcosystemSyncKind,
} from "./cli-sync-mcp";

export const MAX_ECOSYSTEM_JOURNAL_BATCHES = 10;

export interface EcosystemFileChangeRecord {
  targetCli: EcosystemCliId;
  kind: EcosystemSyncKind;
  targetPath: string;
  existed: boolean;
  snapshotFile?: string;
  preDigest: string | null;
  postDigest: string;
  createdDirs: string[];
}

export interface EcosystemSyncBatch {
  batchId: string;
  createdAt: number;
  source: EcosystemCliId;
  targets: EcosystemCliId[];
  kinds: EcosystemSyncKind[];
  overwrite: boolean;
  files: EcosystemFileChangeRecord[];
}

export interface EcosystemSyncJournalDocument {
  schemaVersion: 1;
  batches: EcosystemSyncBatch[];
}

export interface EcosystemBatchSummary {
  batchId: string;
  createdAt: number;
  source: EcosystemCliId;
  targets: EcosystemCliId[];
  kinds: EcosystemSyncKind[];
  overwrite: boolean;
  fileCount: number;
}

export function ecosystemSyncDir(configDir: string): string {
  return join(configDir, "ecosystem-sync");
}

export function ecosystemSnapshotsDir(configDir: string): string {
  return join(ecosystemSyncDir(configDir), "snapshots");
}

export function ecosystemJournalPath(configDir: string): string {
  return join(ecosystemSyncDir(configDir), "journal.json");
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* platform may ignore chmod */
    }
  }
}

export function assertSymlinkFreeAncestors(targetPath: string, stopAt: string): void {
  const normalizedStop = resolve(stopAt);
  let current = resolve(targetPath);
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new EcosystemSyncError(`Refusing symlink path component: ${current}`, 400, "ecosystem_symlink_refused");
      }
    } catch (error) {
      if ((error as { code?: string })?.code !== "ENOENT") {
        if (error instanceof EcosystemSyncError) throw error;
        throw new EcosystemSyncError(`Cannot stat path component ${current}`, 400, "ecosystem_io_error");
      }
    }
    if (current === normalizedStop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function readEcosystemJournal(configDir: string): EcosystemSyncJournalDocument {
  const path = ecosystemJournalPath(configDir);
  const buf = readBoundedNonSymlinkFile(path, MAX_ECOSYSTEM_CONFIG_BYTES, "ecosystem sync journal");
  if (!buf) return { schemaVersion: 1, batches: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new EcosystemSyncError("Ecosystem sync journal is invalid JSON", 500, "ecosystem_journal_corrupt");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
    || !Array.isArray((parsed as { batches?: unknown }).batches)
  ) {
    throw new EcosystemSyncError("Ecosystem sync journal has an unexpected schema", 500, "ecosystem_journal_corrupt");
  }
  return parsed as EcosystemSyncJournalDocument;
}

export function summarizeBatches(doc: EcosystemSyncJournalDocument): EcosystemBatchSummary[] {
  return doc.batches.map(batch => ({
    batchId: batch.batchId,
    createdAt: batch.createdAt,
    source: batch.source,
    targets: [...batch.targets],
    kinds: [...batch.kinds],
    overwrite: batch.overwrite,
    fileCount: batch.files.length,
  }));
}

export function writeEcosystemSnapshotFile(
  configDir: string,
  batchId: string,
  index: number,
  bytes: Uint8Array,
): string {
  assertNotRealHomeUnderTest(configDir);
  const snapshotsRoot = ecosystemSnapshotsDir(configDir);
  const batchDir = join(snapshotsRoot, batchId);
  ensurePrivateDir(ecosystemSyncDir(configDir));
  ensurePrivateDir(snapshotsRoot);
  ensurePrivateDir(batchDir);
  const fileName = `${index}.snap`;
  const snapshotPath = join(batchDir, fileName);
  atomicWriteFileNoFollow(snapshotPath, bytes);
  return join("snapshots", batchId, fileName);
}

export function readEcosystemSnapshotBytes(configDir: string, relativeSnapshotPath: string): Buffer {
  const base = resolve(ecosystemSyncDir(configDir));
  const full = resolve(base, relativeSnapshotPath);
  if (!full.startsWith(`${base}/`) && !full.startsWith(`${base}\\`)) {
    throw new EcosystemSyncError("Invalid snapshot reference in journal", 500, "ecosystem_journal_corrupt");
  }
  const buf = readBoundedNonSymlinkFile(full, MAX_ECOSYSTEM_CONFIG_BYTES * 2, "ecosystem snapshot");
  if (!buf) {
    throw new EcosystemSyncError(`Missing ecosystem snapshot file: ${relativeSnapshotPath}`, 404, "ecosystem_snapshot_missing");
  }
  return buf;
}

export function writeEcosystemJournal(configDir: string, doc: EcosystemSyncJournalDocument): void {
  assertNotRealHomeUnderTest(configDir);
  ensurePrivateDir(ecosystemSyncDir(configDir));
  ensurePrivateDir(ecosystemSnapshotsDir(configDir));
  const retained = doc.batches.slice(0, MAX_ECOSYSTEM_JOURNAL_BATCHES);
  const pruned = doc.batches.slice(MAX_ECOSYSTEM_JOURNAL_BATCHES);
  const nextDoc: EcosystemSyncJournalDocument = {
    schemaVersion: 1,
    batches: retained,
  };
  atomicWriteFileNoFollow(ecosystemJournalPath(configDir), `${JSON.stringify(nextDoc, null, 2)}\n`);
  for (const oldBatch of pruned) {
    removeBatchSnapshotDir(configDir, oldBatch.batchId);
  }
}

export function removeBatchSnapshotDir(configDir: string, batchId: string): void {
  const snapshotsRoot = ecosystemSnapshotsDir(configDir);
  if (!existsSync(snapshotsRoot)) return;
  const targetDir = join(snapshotsRoot, batchId);
  try {
    const stat = lstatSync(targetDir);
    if (stat.isSymbolicLink()) return;
    const realRoot = realpathSync.native(snapshotsRoot);
    const realTarget = realpathSync.native(targetDir);
    if (!realTarget.startsWith(`${realRoot}/`) && !realTarget.startsWith(`${realRoot}\\`)) return;
    rmSync(targetDir, { recursive: true, force: true });
  } catch {
    /* already absent */
  }
}

export async function withEcosystemJournalLock<T>(
  configDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  assertNotRealHomeUnderTest(configDir);
  return withConfigDirHardeningSettled(configDir, () => {
    ensurePrivateDir(ecosystemSyncDir(configDir));
    ensurePrivateDir(ecosystemSnapshotsDir(configDir));
    return undefined;
  }).then(() => withIntegrationWriterLock(join(ecosystemSyncDir(configDir), "sync"), operation));
}
