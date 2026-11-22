/**
 * Lazy runtime dependency barrel for `src/cli/index.ts`.
 *
 * Keeps `--version` and `--help` fast-path exits free from eagerly loading the
 * configuration, server, provider, and adapter module graphs at process boot.
 */
export { serviceStayOutExitCode } from "../service/windows-wrapper-exit";
export { isSupervisedServiceChild, serviceChildOwnershipDecisionForClassifiedChild } from "../service/service-child-ownership";
export { withoutSupervisorMarkers } from "../lib/supervisor-markers";
export { raiseWindowsProxyPriority } from "../service/windows-process-priority";
export { currentServingCommand, deferServiceChildToNewerRuntime, markDelegatedServiceReady, recordServingRuntime } from "../config/serving-runtimes";
export { packageVersion } from "../lib/package-version";
export { codexHomeIsAbsent } from "../codex/codex-home-owner";
export { getCodexHome } from "../codex/paths";
export { admitUpdateRestartChild } from "./update-restart-child";
export { HEALTH_SENTINEL_STANDALONE_ARG, startServiceHealthSentinel } from "../service/health-sentinel-launch";
export { UpdateRestartRequired } from "./update-restart-candidate";
export { reportUpdateRestartFailure, restartFromCurrentInstallation } from "./update-restart";
export { findGuiDist } from "../server/gui-static";
export { inspectGuiBundleFreshness, staleGuiBundleLines } from "../server/gui-freshness";
export {
  currentExternalCodexModelProvider,
  restoreNativeCodex,
  restoreNativeCodexAsync,
  shouldInjectApiAuthHeader,
} from "../codex/inject";
export { readManagedProviderTableBlock } from "../codex/inject/remove";
export { describeRetainedCodexProviderTable } from "../codex/inject/restore";
export { stripGrokConfig } from "../grok/inject";
export { STOP_HISTORY_DEFERRED_EXIT_CODE, STOP_HISTORY_INCOMPLETE_EXIT_CODE, STOP_TEARDOWN_HANDED_OVER_EXIT_CODE } from "../update/stop-contract.mjs";
export { announceStopHandover, completeUpdateTeardownHandover, forgetUpdateTeardownHandover, stopHandsTeardownOver, updateTeardownHandoverRequested } from "../update/teardown-handover";
export {
  describeHistoryJobFailure,
  resolveCodexHistoryJobTarget,
  runCodexHistoryJob,
} from "../codex/history-job";
export { findCrossHomeOwner, markCrossHomeSibling, markLiveHomeSibling } from "./cross-home-owner";
export { clientStartupRefusalMessage, inspectClientRotationRecoveryGate, readClientConnectionState } from "../client/state";
export {
  codexAutoStartEnabled,
  getConfigDir,
  loadConfig,
  saveConfig,
} from "../config";
export {
  isLikelyEpxProcess,
  readPid,
  readPidFileValue,
  readRuntimePort,
  removePid,
  removePidIfValueIs,
  removeRuntimePort,
  removeRuntimePortIfPidIs,
  writePid,
  writeRuntimePort,
} from "../config/process-state";
export { describeTrackedRuntimeTarget } from "../config/tracked-runtime-inspection";
export {
  claimPendingTeardown,
  isPendingTeardownAbandoned,
  listPendingTeardowns,
  pendingTeardownPathFor,
  pendingTeardownsAreExactly,
  quarantinePendingTeardown,
} from "../config/pending-teardown";
export { collectStatus, detectMissingCodexCatalogPath, hubStatusLines, missingCodexCatalogLines, remoteHubBannerLine, remoteHubStatusLines, runtimeSupervisorLine, statusDeadProxyLines, statusProxyUp, statusUnusedProxyLines } from "./status";
export { stopUninstallProxy } from "./uninstall-stop";
export { captureUninstallEndpointProof, endpointsToProve, respawnWindowRequired, sharedTeardownAuthorized, uninstallServiceRemoval } from "./uninstall-plan";
export { takeFlag } from "./runtime-api";
export { parseStartOptions, StartArgsError } from "./start-args";
export {
  discoverStableProxyForRestart,
  recheckRestartFailedStart,
  reobserveRestartReplacement,
  restartStartOutcome,
  waitForProxyReplacement,
  runTrayProxyStart,
} from "./tray-proxy";
export { duplicateRuntimeMessage, runDesktopAwareProxyRestart } from "./desktop-runtime-guidance";
export { deferSupervisedRestart, reportRestartFailure } from "./restart-failure";
export { requestBoundSystemRestart } from "./system-restart-client";
export { installCrashGuards } from "../lib/crash-guard";
export { SpendLedgerOwnerError } from "../lib/spend-ledger-owner";
export { redactUrlForLog } from "../lib/redact";
export { dispatchCommand, decideBusyPreferredPort, decideStartExitTeardown, decideStartWithLiveOwner, startupLeftCodexNativeLine } from "./dispatch";
export { probeOwnerPastRestartParent, takeRestartHandoffMarkers } from "./restart-handoff";
export { AuxiliaryListenerBindError, findAvailablePort, isAddrInUse, PortUnavailableError, shouldPersistSelectedPort, waitForPortAvailable } from "../server/ports";
export {
  findLiveProxy,
  proveLiveProxyOwnedByHome,
  probeEndpointLiveness,
  probeHostname,
  probePortOwner,
  START_OWNERSHIP_LIVENESS,
} from "../server/proxy-liveness";
export { createReadinessGate } from "../server/readiness";
export { isApiAuthRequired } from "../server/auth-cors";
export { runReady } from "./ready";
export { runResolve } from "./resolve";
export {
  approvalChanged,
  guardFinalStopSummary,
  managerStillActive,
  runApprovedStop,
  runGuardedManagerStep,
  settleApprovedTarget,
} from "./stop-approval";
export { summarizeStopRun } from "./stop-report";
export { confirmGuardedFreed, inspectGuardedTarget, noServiceStop, observeGuardedStopped, orphanDiscoveryCap, stopGuardedManager, stopServiceForEpxStop, stopServiceForUninstall, stopWindowFailed, verifyUninstallStopWindow, windowsChildStopHeld, windowsPartAHolds, windowsPartAReceiptRecord, windowsPartBDue, windowsPartBOwnsPortWait, windowsStopRequiresReceipt } from "./stop-windows-checked";
export { runCli } from "./root";
export { isProcessAlive, ProxyOwnershipRefusedError, refusalNextStep, stopProxy } from "../lib/process-control";
export { startupDataPlaneToken } from "../lib/service-secrets";
export { assertNotAdminToken, diagnoseService, isServiceOwnershipError, serviceCommand, serviceEnvironmentOwnedHere, serviceStartableFromTray, serviceStatePaths, serviceStatusSummary, uninstallServiceIfInstalled, uninstallServiceDetailed } from "../service";
export { completeWindowsServiceStopReceipt } from "../service/cli-windows-stop";
export { acquireOwnershipMutationLease } from "../service/ownership-mutation-lease.mjs";
export { formatStartupRoutingDetail, startupHealthSummary } from "../codex/autostart-health";
export { injectSystemEnv, reconcileShellHook, revertSystemEnv, uninstallShellHook } from "../server/system-env";
export { startTokenGuardian } from "../oauth/token-guardian";
export { startHistoryMigrationGuardian } from "../codex/history-migration-guardian";
export { maybeShowStarPrompt } from "./star-prompt";
export { maybeShowUpdatePrompt } from "../update/notify";
export {
  bindAndPublishStartOwnership,
  StartOwnershipRollbackUncertainError,
} from "./start-ownership-publication";
export { syncModelsToCodex } from "../codex/sync";
export { localClientSkipReason, shouldSyncCodexOnStart, shouldSyncGrokOnStart, syncCodexOnStartIfEnabled } from "../codex/desired-state";
export { honorSiblingMarker, markSiblingStart, siblingOfLivePort, siblingRuntimeField, siblingStopFoundOwner, withoutSiblingMarker } from "../codex/sibling-start";
export { consumeSiblingHandoff } from "../codex/sibling-handoff";
export {
  reconcileClientStartupBeforeReady,
  syncCodexBeforeCatalogObservation,
  syncClaudeAgentDefsAtProxyStartup,
} from "./claude-agent-startup-sync";
export {
  grokSyncFailureMessage,
  reconcileEnsureDesiredIntegrations,
} from "./ensure-desired-integrations";
export { ENSURE_READY_TIMEOUT_MS, ensureKeepWaiting, waitForLiveProxy } from "./ensure-readiness";
export { productionDesktopColdStartDeps, runDesktopColdStart } from "./ensure-desktop-cold-start";
export { refreshOwnedCatalogIntegrations } from "../integrations/catalog-refresh";
export { loadExportModels } from "../server/management/model-rows";
export { removeOwnedConfigAfterDesktopCleanup } from "./uninstall-client-state";
export { uninstallPrivilegeRefusal } from "../lib/config-ownership";
export { withProcessRuntimeProvenance } from "../lib/bun-runtime";
export { startArgv } from "../lib/self-launch-argv";
export {
  abandonedTeardownIsSafeToFinish,
  assertConnectedClientStopSupported,
  classifyStopRole,
  clearRestoredStopReceipts,
  configuredStopEndpoint,
  connectedClientStopSkipLine,
  isRegisteredServiceStopTarget,
  notOwnedTeardownIsAcceptable,
  preflightConnectedClientStop,
  preserveConnectedClientRoutingOnExit,
  proveStandaloneStopRecord,
  restoreBoundaryOwnership,
  restoreSharedClientStateAfterStop,
  settleUnrestoredStopBoundary,
  stopOwnershipRefused,
  unclassifiedStopTarget,
  unsupportedConnectedStop,
  verifyConnectedStopTarget,
} from "./stop-restore";
export { stopRestoreWriteGuard } from "./stop-restore-guard";
export { startConnectedClientWithOwnershipFence } from "./client-start-fence";
export { recoverStartJournalAfterOwnerRecheck, recoverStartStateUnderOwnershipLease } from "./start-owner-fence";
export { handledSignalExitCode } from "../lib/handled-signal-exit";
export { createLocalAttestationSecret } from "../lib/local-management-attestation";
export { MEMORY_DRAIN_RESTART_MS, REPLACEMENT_READY_TIMEOUT_MS, RESTART_REOBSERVE_RESERVE_MS } from "../lib/system-restart-contract";
export { startServiceLogging } from "../service/logging";
