import type { ResponsesTerminalStatus } from "../bridge";
import type { CodexAffinityMove, CodexAffinityReason } from "../codex/routing";
import type { CYBER_POLICY_ERROR_CODE } from "../lib/errors";
import type { RequestExecutionBudget } from "../lib/request-execution-budget";
import type { UpstreamCondition } from "../lib/upstream-condition";
import type { WorkflowSpendDenialDetail } from "../lib/workflow-budget";
import type { ProtocolTraceV1 } from "../protocols/dto";
import type { AdapterTierMetadata } from "../providers/fastwire";
import type { RouteDecisionTraceV1 } from "../routing/trace";
import type { AttemptTierOutcome, CacheAffinityLogReason, CacheAffinityOutcome, EpxUsage } from "../types";
import type { CacheDiagnosticDraft } from "../usage/cache-diagnostic";
import type { UsageClient } from "../usage/client";
import type { PersistedJevDecisionV1 } from "../usage/jev-stats";
import type {
  CacheTelemetryProvenance,
  PersistedClaudeCompatibilityLog,
  PersistedRequestSpend,
  PersistedUsageAttempt,
  RequestFailureCause,
  RequestFailureStage,
  UsageStatus,
} from "../usage/log";
import type { ApiKeyBudgetLease } from "./api-key-budget";
import type { OtlpRequestSpanHandle } from "../telemetry/otlp";
import type { RequestBodyEntryField, RequestBodyLogContext } from "./request-body-facts";
import type { CommittedComboLogFields } from "./request-log-committed-terminal";
import type { FailureDetail } from "./request-log-failure-detail";
import type { LinkRequestLogCarrier, UpstreamErrorDiagnostics } from "./request-log-terminal-status";
import type { RequestMetricsRecorder } from "./request-metrics";
import type { RequestSpendSettlement } from "./responses/request-spend";

export interface RequestLogContext extends UpstreamErrorDiagnostics, LinkRequestLogCarrier, RequestBodyLogContext, CommittedComboLogFields {
  model: string;
  provider: string;
  client?: UsageClient;
  /** Optional process-lifetime aggregate sink, injected by the server composition owner. */
  requestMetricsRecorder?: RequestMetricsRecorder;
  /** Optional per-key budget reservation lease settled or rolled back once at final log time. */
  apiKeyBudgetLease?: ApiKeyBudgetLease;
  /** Optional process-local OTLP tracing span finished once at final log time; never persisted. */
  otlpSpan?: OtlpRequestSpanHandle;
  /** Bounded terminal enum observed while inspecting a buffered response body. */
  observedTerminalStatus?: ResponsesTerminalStatus;
  /**
   * Identity of the ONE logical request this context serves (#4546). Set from the execution
   * budget minted at ingress; a retry leg, a repair refetch and a combo child share it.
   */
  logicalRequestId?: string;
  /** Process-local privacy-bounded cache diagnostic; never persisted with request logs. */
  cacheDiagnosticDraft?: CacheDiagnosticDraft;
  /**
   * Internal live reference to this request's execution budget; omitted from RequestLogEntry and
   * JSONL. Read at final-log time so the row reports the budget's FINAL state rather than a
   * snapshot taken before the recovery legs that the row is meant to explain.
   */
  executionBudget?: RequestExecutionBudget;
  /**
   * True once usage counts were taken from a response wire rather than reported raw by the
   * adapter. It decides cache provenance: the normalizer writes zero-default token-detail
   * objects, so an all-zero cache detail from a parsed wire is not a measured cache miss.
   */
  usageWireParsed?: boolean;
  /**
   * Every affinity reason recorded for this request, in order. `affinityReason` keeps the final
   * one for the existing row shape; a request that moved twice has two causes and losing the
   * first one loses the more expensive half of the story.
   */
  affinityMoveReasons?: CodexAffinityReason[];
  /** TTFT: ms from request start to the first non-empty model output delta (WP4, devlog 040). */
  firstOutputMs?: number;
  /** Epoch ms of the first output item and of the last output delta; see request-log-generation-window.ts. */
  generationStartedAt?: number;
  lastOutputAt?: number;
  /** Best-effort chat/session correlation for Logs grouping (#330). Opaque; omit when unknown. */
  conversationId?: string;
  /** In-memory only: conversationId holds the log-only Hermes digest, which a native id replaces. */
  conversationIdIsHermesFallback?: boolean;
  surface?: "claude" | "claude-desktop" | "grok";
  /** The matched configured key's id. Set ONLY for admissionKind "configured" —
   *  never a sentinel, so a hand-edited entry whose id happens to be "loopback"
   *  cannot absorb unrelated traffic. */
  apiKeyId?: string;
  /** Which kind of admission opened this request. Carries no secret. */
  admissionKind?: "configured" | "environment" | "loopback";
  /** Which inbound wire was used. Orthogonal to `surface`, which names the client
   *  product: widening that enum would merge Responses and Chat Completions,
   *  since both leave it undefined. */
  inboundProtocol?: "responses" | "chat" | "messages";
  /**
   * Set when an adapter answered the turn locally and no upstream request was made
   * (`ProviderAdapter.localTerminal`). A fixed identifier naming the code path, never
   * conversation-derived: it exists so a request log showing zero sends is explainable
   * rather than looking like a lost request.
   */
  localTerminalReason?: string;
  /** Stable non-PII Codex Pool account identity for durable usage attribution. */
  accountLogLabel?: string;
  requestedModel?: string;
  /** User-facing alias selector when routing resolved one; native model remains `model`. */
  requestedAlias?: string;
  /** Original bare helper model when the opt-in shadow-call route rewrote this request. */
  shadowCallRewrittenFrom?: string;
  /** Internal structural combo identity; omitted from RequestLogEntry/JSONL. */
  comboId?: string;
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
  callerServiceTier?: string;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
  /** Final-attempt tier summary; attempt rows remain the accounting source of truth. */
  tierOutcome?: AttemptTierOutcome;
  resolvedModel?: string;
  /** Upstream served model, retained beside resolvedModel so an upstream reroute stays visible. */
  servedModel?: string;
  /** The exact model id sent upstream; recorded when a route/virtual rewrite makes it differ
   * from the client-facing `model`, so a served-model mismatch can be judged against the wire. */
  wireModel?: string;
  /** Internal: client-facing response metadata must not replace the physical routed model. */
  preserveResolvedModelFromRoute?: boolean;
  /** Internal: client-facing selector written into response.model; never an upstream observation. */
  responseModelEcho?: string;
  usage?: EpxUsage;
  usageLogInputTokens?: number;
  /**
   * The output ceiling this request may actually spend, for the durable spend reservation
   * (#4707). Captured from the caller's `max_output_tokens`; absent when the caller omitted it
   * and the adapter's own provider/model default decides, in which case only the input estimate
   * is reserved up front and settlement corrects it.
   */
  spendOutputCeilingTokens?: number;
  /** Pre-send input estimate reserved for spend only; unlike usageLogInputTokens it never enters usage. */
  spendInputEstimateTokens?: number;
  /** Canonical provider-pool spend identity; independent of mutable, account-specific log labels. */
  spendPoolId?: string;
  /** Internal safe refusal detail for a request whose ceiling includes unidentified old pool spend. */
  spendRefusalDetail?: WorkflowSpendDenialDetail;
  /** Settles this request's durable spend entries from `addFinalRequestLog`. */
  spendTracker?: RequestSpendSettlement;
  attempts?: PersistedUsageAttempt[];
  /** Internal mutable final attempt; omitted from RequestLogEntry/JSONL. */
  activeAttempt?: PersistedUsageAttempt;
  /** Internal wall-clock origin for the committed final attempt; never persisted. */
  activeAttemptStartedAt?: number;
  /** Internal adapter response observer paired with activeAttempt.tierOutcome. */
  activeTierMetadata?: AdapterTierMetadata;
  usageDebugBodyKind?: import("../usage/debug").UsageDebugBodyKind;
  usageDebugBodySample?: string;
  usageDebugContentType?: string;
  /** Route adapter type ("cursor"/"kiro"/"anthropic"/…): drives estimated-usage detection
   *  independent of the user-chosen provider NAME (devlog 130 B2). */
  providerAdapter?: string;
  /** Set when the bridge reported raw adapter usage via onUsage: the bridged wire now always
   *  carries synthetic zero-default token-detail objects (strict-client normalization, see
   *  responsesUsage in src/bridge.ts), so SSE/JSON re-parsing must not overwrite the raw
   *  provenance — a synthetic cached_tokens:0 is NOT a measured cache read. */
  usageFromBridge?: boolean;
  /** Process-owned provenance when a later parse of the client body must skip its usage.
   *  The original provider usage, when present, is already recorded on this context. */
  clientResponseUsage?: "estimated" | "synthetic";
  /** A committed keepalive's native child owns raw usage; only the outer client-body log tap skips it. */
  clientSseUsageAlreadyInspected?: boolean;
  /** Secret-redacted upstream error reason (e.g. the granular Cursor "rate limit exceeded…"
   * message) extracted from a `response.failed` SSE payload or non-streaming error body, so the
   * request log / GUI shows the actual upstream failure rather than only the HTTP-mapped code. */
  upstreamError?: string;
  failureDetail?: FailureDetail; // closed code + bounded params (src/lib/failure-detail.ts)
  upstreamCondition?: UpstreamCondition; // classified at capture where the evidence is not kept on the context
  /** HTTP status derived from a terminal `response.failed` SSE payload (429/401/503/etc.). */
  terminalHttpStatus?: number;
  /** Status of an upstream `error` event that ended a 200 Messages stream; the row stays 200, a combo child reads it. */
  streamErrorStatus?: number;
  /** Bytes other than a ping followed that upstream `error` event, so a retry would repeat output. */
  streamErrorFollowed?: true;
  /** Recognized structured terminal code whose exact identity must survive status mapping. */
  terminalErrorCode?: typeof CYBER_POLICY_ERROR_CODE;
  /**
   * Proxy-owned error code for a request EasyProxy terminated locally, before or instead of an
   * upstream send. Status-derived classification cannot name these: there is no upstream
   * message to classify, and the status alone would read as a provider failure.
   */
  errorCode?: string;
  /** Structured reason from `response.incomplete`; internal-only input to log classification. */
  terminalIncompleteReason?: string;
  affinity?: CodexAffinityMove;
  /** Why the binding was kept, moved, or released (#4546). */
  affinityReason?: CodexAffinityReason;
  /**
   * Set when this request dropped account-bound continuation because the serving
   * Codex pool account was not the issuer. Never an account identifier.
   */
  conversationStateScrub?: "account-change";
  /** Explicit session lane for provider cache affinity; internal only, never persisted raw. */
  affinityLane?: string;
  affinityKeyEntryId?: string;
  /** Configured provider owning the serving entry, independent of combo display labels. */
  affinityProviderName?: string;
  /** Whether provider cache affinity applies to this request's provider at all. */
  cacheAffinityApplicable?: boolean;
  /** Entry the consult kept this request on, when it did; rotation may still move it. */
  affinityKeptEntryId?: string;
  /** Model identity affinity consults with; recording reuses it so virtual models match. */
  affinityModel?: string;
  /** Provider cache-affinity outcome for this request (bounded enum, persisted on the entry). */
  cacheAffinity?: CacheAffinityOutcome;
  cacheAffinityReason?: CacheAffinityLogReason;
  transportPhase?: "pre_headers" | "mid_stream" | "terminal_sse";
  terminalSource?: "upstream" | "synthetic";
  /** Closed failure evidence supplied by the transport, never inferred from provider text. */
  causeHint?: RequestFailureCause;
  /** Bounded route-decision trace (RI-01); never contains secrets. */
  routeDecision?: RouteDecisionTraceV1;
  /** Full eligible provider/model membership from a policy route; never logged. */
  policyEligibility?: ReadonlySet<string>;
  /** Privacy-bounded JEV selection metadata; downstream usage is recorded on attempts[]. */
  jevDecision?: PersistedJevDecisionV1;
  /** Opt-in shadow evidence, normalized again at the logging boundary. */
  claudeCompatibility?: PersistedClaudeCompatibilityLog;
}

export interface RequestLogEntry extends UpstreamErrorDiagnostics, LinkRequestLogCarrier, RequestBodyEntryField {
  requestId: string;
  client?: UsageClient;
  /** The logical request this row belongs to (#4546); absent on rows written without a budget. */
  logicalRequestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  /** TTFT: ms from request start to the first non-empty model output delta; unset for non-streaming/tool-only. */
  firstOutputMs?: number;
  /** Request-relative generation window (#6309): first output item of any kind, then the last output delta. */
  genStartMs?: number;
  lastOutputMs?: number;
  surface?: "claude" | "claude-desktop" | "grok";
  /**
   * Set when the proxy answered this turn locally and sent nothing upstream. Without it a zero-send
   * row is indistinguishable from a request that vanished. A fixed adapter-supplied identifier,
   * never conversation-derived.
   */
  localTerminalReason?: string;
  /** The matched configured key's id. Set ONLY for admissionKind "configured" —
   *  never a sentinel, so a hand-edited entry whose id happens to be "loopback"
   *  cannot absorb unrelated traffic. */
  apiKeyId?: string;
  /** Which kind of admission opened this request. Carries no secret. */
  admissionKind?: "configured" | "environment" | "loopback";
  /** Which inbound wire was used. Orthogonal to `surface`, which names the client
   *  product: widening that enum would merge Responses and Chat Completions,
   *  since both leave it undefined. */
  inboundProtocol?: "responses" | "chat" | "messages";
  accountLogLabel?: string;
  /** Anthropic pool account of `provider` (#8383): its p-label, beside the unchanged `accountLogLabel`. */
  accountTag?: `p${string}`;
  /** Best-effort chat/session correlation for Logs grouping (#330). */
  conversationId?: string;
  requestedModel?: string;
  requestedAlias?: string;
  /** Original bare helper model when the opt-in shadow-call route rewrote this request. */
  shadowCallRewrittenFrom?: string;
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
  callerServiceTier?: string;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
  tierOutcome?: AttemptTierOutcome;
  resolvedModel?: string;
  /** Model the upstream actually served (openai-model header or response body). */
  servedModel?: string;
  /** The exact model id sent upstream when it differs from the client-facing `model`. */
  wireModel?: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  terminalStatus?: ResponsesTerminalStatus;
  closeReason?: "terminal" | "client_cancel" | "non_stream" | "body_stall" | "body_overflow";
  /** Input only: addRequestLog derives the two fields below from it, then removes it. */
  upstreamError?: string;
  upstreamCondition?: UpstreamCondition; // closed enum, src/lib/upstream-condition.ts
  failureDetail?: FailureDetail; // closed code + bounded params, see request-log-failure-detail.ts
  rateLimitResetAt?: number; // provider quota window end, epoch ms, bounded
  usageStatus: UsageStatus;
  usage?: EpxUsage;
  totalTokens?: number;
  attempts?: PersistedUsageAttempt[];
  /** True when persistence normalization drops any attempt. */
  attemptNormalizationDropped?: boolean;
  /**
   * Upstream spend for the whole logical request: sends aggregated across attempts and combo
   * children, split into settled and unresolved, with the budget state and move reasons that
   * explain them. Per-attempt `sendCount` stays the accounting source; this is the total.
   */
  spend?: PersistedRequestSpend;
  /** Whether this row's cache detail was observed, synthesized for the wire, or absent. */
  cacheProvenance?: CacheTelemetryProvenance;
  /** Codex pool affinity decision for this request (diagnostics for #186). */
  affinity?: CodexAffinityMove;
  /** Why that decision was made (#4546): a move is the expensive event, so it names its cause. */
  affinityReason?: CodexAffinityReason;
  /** Provider cache-affinity outcome: kept on, newly bound to, or released from a key-pool credential. */
  cacheAffinity?: CacheAffinityOutcome;
  cacheAffinityReason?: CacheAffinityLogReason;
  /**
   * Set when this request dropped account-bound continuation after a Codex pool
   * account change. Never an account identifier.
   */
  conversationStateScrub?: "account-change";
  /** Where the upstream terminal/failure was observed. */
  transportPhase?: "pre_headers" | "mid_stream" | "terminal_sse";
  /**
   * Whether the HTTP status and message originated upstream or were synthesized by this
   * proxy. Covers SSE tails and pre-stream JSON refusals. Management surfaces this so a
   * local refusal cannot be presented as an upstream reason.
   */
  terminalSource?: "upstream" | "synthetic";
  /** Bounded route-decision trace (RI-01); never contains secrets. */
  routeDecision?: RouteDecisionTraceV1;
  /** Privacy-bounded JEV selection metadata; downstream usage is recorded on attempts[]. */
  jevDecision?: PersistedJevDecisionV1;
  /** Closed Claude protocol codes; no request or header values. */
  claudeCompatibility?: PersistedClaudeCompatibilityLog;
  /**
   * How far this request got and why it failed, in the shared stage and cause vocabulary
   * (#2366). Derived once at the single finalization seam and carried on the row so the
   * dashboard, the durable ledger and the exporter read one answer instead of three.
   */
  failureStage?: RequestFailureStage;
  failureCause?: RequestFailureCause;
  /** Observed protocol path (PF-02, `src/protocols/trace.ts`); absent when nothing was observed. */
  protocolTrace?: ProtocolTraceV1;
}
