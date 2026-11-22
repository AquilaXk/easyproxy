import { join } from "node:path";
import { rmSync } from "node:fs";
import type { ClientFacingModelLabel } from "../../lib/error-destination";
import { hasResponseMediaType } from "../../lib/http-response-semantics";
import { isProxyError } from "../../lib/client-error-body";
import type { RequestExecutionBudget } from "../../lib/request-execution-budget";
import { WORKFLOW_LOCAL_REFUSAL_HEADER } from "../../lib/workflow-budget";
import type { AdmissionLease } from "../../lib/admission";
import type { CapturedAdmissionPolicy } from "../../types/admission-policy";
import type { EpxConfig } from "../../types";
import { formatErrorResponse } from "../../bridge";
import { getConfigDir } from "../../config";
import { buildCompactV1Output, decodeCompactionSummary, extractCompactUserMessages } from "../../responses/compaction";
import { applyReasoningRetention, appendRetentionNotice, type ReasoningRetentionResult } from "../../responses/reasoning-retention";
import { FORWARD_HEADERS } from "../../adapters/openai-responses";
import { isUnattendedAgyAcpHttpTurn } from "../../adapters/agy-acp/policy";
import { copyResponsesClientMetadata } from "../../adapters/openai-responses/transport";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import type { RouteResult } from "../../router";
import { resolveContextPrincipal, type DataPlaneAdmission } from "../auth-cors";
import { consumeForInspection } from "../relay";
import type { RequestLogContext } from "../request-log";
import { linkRequestSessionLane } from "../request-log-conversation";
import { agyAcpPreflightResponse } from "./agy-acp-preflight";
import type { CompactionRoutingOverride } from "./compaction-routing";
import { upstreamErrorCode } from "./context-overflow";
import { handleResponses } from "./core";
import { rememberCompactHandoffRoute } from "./compact-handoff-routes";

export interface RoutedCompactTurnOptions {
  clientModelLabel?: ClientFacingModelLabel;
  advisorAdmissionPolicy?: CapturedAdmissionPolicy;
  compactionRoutingOverride?: CompactionRoutingOverride | null;
}

export async function runRoutedCompactTurn(args: {
  req: Request;
  raw: { model: string; input?: unknown };
  config: EpxConfig;
  route: RouteResult;
  logCtx: RequestLogContext;
  turnAdmissionLease: AdmissionLease | undefined;
  admission: DataPlaneAdmission | undefined;
  sendBudget: RequestExecutionBudget;
  accountGatedCompactWireModel: string | undefined;
  nativeNotFound: Response | undefined;
  options: RoutedCompactTurnOptions;
}): Promise<Response> {
  const {
    req,
    raw,
    config,
    route,
    logCtx,
    turnAdmissionLease,
    admission,
    sendBudget,
    accountGatedCompactWireModel,
    nativeNotFound,
    options,
  } = args;
  // ROUTED model: run the v2 synthetic-compaction turn internally (appends COMPACT_PROMPT, no
  // tools) and decode the resulting epx1 envelope into plain v1 replacement-history items.
  const agyAcpUnattendedHttpTurn = isUnattendedAgyAcpHttpTurn(req.headers, raw);
  // A direct refusal has no summarizer, so it must not create a reasoning archive.
  if (agyAcpUnattendedHttpTurn && !route.combo && route.routeKind !== "policy" && route.provider.adapter === "agy-acp") {
    const refusal = agyAcpPreflightResponse({
      adapterName: route.provider.adapter, requestHeaders: req.headers, forwardHeaders: req.headers,
      body: raw, unattendedHttpTurn: true, comboAttempt: false, internalDecisionCall: false, subagentFallback: false, logCtx,
    });
    if (refusal) return refusal;
  }
  const rawInputItems = Array.isArray(raw.input) ? (raw.input as unknown[]) : [];
  // Keep readable reasoning local until success, outside the summarizer request.
  // Opaque compaction responses below keep their original protocol and ciphertext.
  const retention: ReasoningRetentionResult = config.reasoningRetention?.enabled === true
    && !isCanonicalOpenAiForwardProvider(route.provider) ? applyReasoningRetention(rawInputItems, {
    archiveDir: join(getConfigDir(), "reasoning-archive"),
    contextWindow: route.staticPolicy.model.contextWindow ?? route.staticPolicy.model.maxInputTokens,
    maxContextPercent: config.reasoningRetention?.maxContextPercent,
    maxTokens: config.reasoningRetention?.maxTokens,
  }) : { input: rawInputItems };
  let keepArchive = false;
  try {
    const inputItems = retention.input;
    const internalBody = {
      ...raw,
      // Canonical ChatGPT Responses rejects non-streaming turns. Daybreak cannot use the
      // native compact endpoint either, so run its synthetic compaction as SSE and collapse
      // the completed event back into the v1 compact JSON contract below. Combo-dispatched
      // turns also go out as SSE: failover can land on a canonical child that rejects a
      // non-streaming turn, and every combo-capable provider already serves streaming traffic.
      stream: isCanonicalOpenAiForwardProvider(route.provider) || accountGatedCompactWireModel || route.combo ? true : false,
      input: [...inputItems, { type: "compaction_trigger" }],
    };
    const internalHeaders = new Headers({ "content-type": "application/json" });
    for (const name of FORWARD_HEADERS) {
      const value = req.headers.get(name);
      if (value || (value !== null && (name === "x-codex-installation-id" || name === "x-codex-turn-metadata"))) internalHeaders.set(name, value);
    }
    copyResponsesClientMetadata(internalHeaders, req.headers, route.provider);
    const internalReq = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify(internalBody),
    });
    linkRequestSessionLane(req, internalReq);
    // The routed compaction turn is a handoff inside the same logical request, so it draws the
    // REMAINDER. Minting here is what let a native attempt spend three sends and the routed
    // fallback spend four more.
    // internalReq keeps only FORWARD_HEADERS, so the caller principal is resolved from req.
    const replayPrincipal = { clientPrincipalId: resolveContextPrincipal(req, config, admission) };
    const sendsBeforeHandoff = sendBudget.used;
    const priorTerminalSource = logCtx.terminalSource;
    const priorErrorCode = logCtx.errorCode;
    const priorLocalReason = logCtx.localTerminalReason;
    const priorSpendDetail = logCtx.spendRefusalDetail;
    const response = await handleResponses(internalReq, config, logCtx, {
      clientModelLabel: options.clientModelLabel, abortSignal: req.signal, turnAdmissionLease, sendBudget,
      compactionRecoveryKind: "compaction-v1", compactionRoutingOverride: options.compactionRoutingOverride,
      advisorAdmissionPolicy: options.advisorAdmissionPolicy, replayPrincipal, agyAcpUnattendedHttpTurn,
      ...(admission ? { admission } : {}),
    });
    if (req.signal.aborted) {
      void response.body?.cancel(req.signal.reason).catch(() => undefined);
      void nativeNotFound?.body?.cancel(req.signal.reason).catch(() => undefined);
      return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    }
    if (nativeNotFound && response.status === 429 && sendBudget.used === sendsBeforeHandoff && isProxyError(response)
      && (response.headers.has(WORKFLOW_LOCAL_REFUSAL_HEADER)
        || upstreamErrorCode(await response.clone().text()) === "request_send_budget_exhausted")) {
      await response.body?.cancel().catch(() => undefined);
      logCtx.terminalSource = priorTerminalSource;
      logCtx.errorCode = priorErrorCode;
      logCtx.localTerminalReason = priorLocalReason;
      logCtx.spendRefusalDetail = priorSpendDetail;
      return nativeNotFound;
    }
    void nativeNotFound?.body?.cancel().catch(() => undefined);
    if (!response.ok) return response;
    let json: { output?: unknown[]; status?: unknown; error?: unknown };
    if (hasResponseMediaType(response.headers, "text/event-stream")) {
      if (!response.body) {
        return formatErrorResponse(502, "server_error", "compaction turn returned an empty event stream");
      }
      const terminal = { status: "incomplete" as "completed" | "failed" | "incomplete" };
      let completed: { id?: unknown; output?: unknown; status?: unknown } | undefined;
      await new Promise<void>(resolve => {
        consumeForInspection(
          response.body!,
          status => { terminal.status = status; },
          req.signal,
          resolve,
          undefined,
          undefined,
          value => { completed = value; },
        );
      });
      if (req.signal.aborted) {
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      if (terminal.status !== "completed" || !completed) {
        return formatErrorResponse(502, "upstream_error", `compaction turn did not complete (status: ${terminal.status})`);
      }
      json = completed as { output?: unknown[]; status?: unknown; error?: unknown };
    } else {
      try {
        json = await response.json() as { output?: unknown[]; status?: unknown; error?: unknown };
      } catch {
        return formatErrorResponse(502, "server_error", "compaction turn returned a non-JSON response");
      }
    }
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    }
    // The internal turn answers 200 even when it failed or was truncated, so the body
    // has to be inspected. Reporting a failure beats installing "(no summary
    // available)" as replacement history and silently losing the conversation (#422).
    if (json.error) {
      const message = typeof json.error === "string"
        ? json.error
        : (json.error as { message?: unknown })?.message;
      return formatErrorResponse(502, "upstream_error", typeof message === "string" ? message : "compaction turn failed");
    }
    if (json.status !== "completed") {
      return formatErrorResponse(
        502,
        "upstream_error",
        `compaction turn did not complete (status: ${String(json.status ?? "unknown")})`,
      );
    }
    const compactionItems = (json.output ?? []).filter(
      (item): item is { type: string; encrypted_content?: string } =>
        !!item && typeof item === "object" && (item as { type?: string }).type === "compaction",
    );
    if (compactionItems.length !== 1) {
      return formatErrorResponse(
        502,
        "invalid_response_error",
        `compaction turn produced ${compactionItems.length} compaction items, expected exactly 1`,
      );
    }
    // Native Responses backends return a real opaque OpenAI-encrypted compaction item. EPX cannot
    // and should not decrypt it; preserve that item for /responses/compact callers. Synthetic
    // routed summaries are our `epx1:` envelope and must be decoded into v1 history items.
    if (typeof compactionItems[0]!.encrypted_content === "string"
      && compactionItems[0]!.encrypted_content.trim().length > 0
      && !compactionItems[0]!.encrypted_content.startsWith("epx1:")) {
      // Failover may reach native compaction after readable reasoning was withheld locally.
      // The opaque item cannot contain that text, so publish it (or its archive notice) alongside.
      const output = [...compactionItems, ...(retention.retainedReasoning ?? [])];
      if (retention.archived) output.push({ type: "message", role: "user",
        content: [{ type: "input_text", text: appendRetentionNotice("", retention.archived).trimStart() }] });
      const result = new Response(JSON.stringify({ output }), {
        headers: { "Content-Type": "application/json" },
      });
      if (!options.compactionRoutingOverride) rememberCompactHandoffRoute(req, admission, raw.model);
      keepArchive = true;
      return result;
    }
    const encrypted = compactionItems[0]!.encrypted_content;
    const decoded = typeof encrypted === "string" ? decodeCompactionSummary(encrypted) : null;
    // An empty `epx1:` envelope decodes to "" rather than null, so length is what matters.
    if (decoded === null || decoded.trim().length === 0) {
      return formatErrorResponse(502, "invalid_response_error", "compaction turn produced an empty summary");
    }
    const summary = appendRetentionNotice(decoded, retention.archived);
    const output = [...buildCompactV1Output(extractCompactUserMessages(inputItems), summary),
      ...(retention.retainedReasoning ?? [])];
    if (!options.compactionRoutingOverride) rememberCompactHandoffRoute(req, admission, raw.model);
    const result = new Response(JSON.stringify({ output }), { headers: { "Content-Type": "application/json" } });
    keepArchive = true;
    return result;
  } finally {
    // Keep an archive only after successful replacement history publishes its path.
    if (!keepArchive && retention.archived) rmSync(retention.archived.path, { force: true });
  }
}
