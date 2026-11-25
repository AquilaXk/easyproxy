import { anthropicErrorResponse } from "../claude/outbound";
import { markProxyError } from "../lib/client-error-body";
import { normalizeMessagesProxyRefusal } from "../lib/messages-error-body";
import { isApiKeyExpired, resolveApiAuth, resolveResponsesApiAuth, withCors, type RequestPolicyView } from "./auth-cors";
import {
  acquireApiKeyBudgetLease,
  hasApiKeyBudgetLimits,
  type ApiKeyBudgetLease,
} from "./api-key-budget";
import { runAdmittedBodyWork } from "./inbound-body-admission";
import { tryAdmitTurn, type ActiveTurnLease } from "./lifecycle";
import { addFinalRequestLog, markLocalRequestLogRefusal } from "./request-log";
import { requestBodyFactsHolder, wasRequestBodyRejected } from "./request-body-facts";
import { sessionLaneIdFromRequest } from "./request-log-conversation";
import { admitHttpWorkflowTurn, workflowDecisionRefusalResponse, type WorkflowRefusalLog } from "./workflow-refusal";

export interface AdmittedHttpTurnOptions {
  mapRefusal?: (response: Response) => Response;
  onAdmissionError?: (error: unknown) => Response;
}

async function buildAdmittedKeyRefusal(
  req: Request,
  policy: RequestPolicyView,
  map: (response: Response) => Response,
  status: number,
  errorType: "authentication_error" | "rate_limit_error",
  code: string,
  message: string,
  refusalLog?: WorkflowRefusalLog,
  retryAfterSec?: number,
): Promise<Response> {
  if (refusalLog) {
    markLocalRequestLogRefusal(refusalLog.logCtx, code);
    refusalLog.logCtx.errorCode = code;
    addFinalRequestLog(refusalLog.requestId, refusalLog.start, refusalLog.logCtx, status);
    refusalLog.onLogged?.();
  }
  const pathname = (() => {
    try { return new URL(req.url).pathname; } catch { return ""; }
  })();
  const isMessages = pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens";
  const rawRefusal = isMessages
    ? anthropicErrorResponse(status, message, errorType, code)
    : Response.json({
      error: {
        type: errorType,
        code,
        message,
      },
    }, { status });
  if (retryAfterSec !== undefined) rawRefusal.headers.set("Retry-After", String(retryAfterSec));
  const refusal = markProxyError(rawRefusal);
  return withCors(await normalizeMessagesProxyRefusal(req, map(refusal)), req, policy);
}

export function createAdmittedHttpTurn(
  configuredLimit: () => number | undefined,
  serverBusyResponse: (req: Request, resource: string, policy: RequestPolicyView) => Response,
) {
  return async function runAdmittedHttpTurn(
    req: Request,
    policy: RequestPolicyView,
    work: (lease: ActiveTurnLease) => Promise<Response>,
    refusalLog?: WorkflowRefusalLog,
    options?: AdmittedHttpTurnOptions,
  ): Promise<Response> {
    const map = (response: Response) => options?.mapRefusal ? options.mapRefusal(response) : response;
    // The row carries the size and encoding of the body this turn's handler reads from `req` (#3023).
    if (refusalLog) refusalLog.logCtx.requestBodyHolder ??= requestBodyFactsHolder(req);
    let budgetLease: ApiKeyBudgetLease | undefined;
    const admittedKeyId = refusalLog?.logCtx.apiKeyId ?? (policy.apiKeys?.length ? (() => {
      const adm = resolveApiAuth(req, policy) ?? resolveResponsesApiAuth(req, policy);
      return adm?.kind === "configured" ? adm.keyId : undefined;
    })() : undefined);
    const configuredAdmissionWithoutKeyId = refusalLog?.logCtx.admissionKind === "configured" && !admittedKeyId;
    if (admittedKeyId || configuredAdmissionWithoutKeyId) {
      const entry = admittedKeyId ? policy.apiKeys?.find(k => k.id === admittedKeyId) : undefined;
      if (!entry || isApiKeyExpired(entry)) {
        return buildAdmittedKeyRefusal(
          req,
          policy,
          map,
          401,
          "authentication_error",
          "invalid_api_key",
          "easyproxy API key is invalid, expired, or revoked",
          refusalLog,
        );
      }
      if (hasApiKeyBudgetLimits(entry)) {
        const budget = acquireApiKeyBudgetLease(entry);
        if (!budget.allowed) {
          return buildAdmittedKeyRefusal(
            req,
            policy,
            map,
            429,
            "rate_limit_error",
            budget.reason,
            "API key request budget exceeded.",
            refusalLog,
            budget.retryAfterSec,
          );
        }
        budgetLease = budget.lease;
      }
    }
    const lease = tryAdmitTurn(sessionLaneIdFromRequest(req.headers), req.signal);
    if (!lease) {
      budgetLease?.releaseUnused();
      const response = serverBusyResponse(req, "active turns", policy);
      refusalLog?.logCtx.otlpSpan?.finish({ status: response.status, errorCode: "server_busy" });
      return options?.mapRefusal ? withCors(map(response), req, policy) : response;
    }
    let workflow: ReturnType<typeof admitHttpWorkflowTurn>;
    try { workflow = admitHttpWorkflowTurn(req.headers); }
    catch (error) {
      budgetLease?.releaseUnused();
      lease.release();
      refusalLog?.logCtx.otlpSpan?.finish({
        status: req.signal.aborted ? 499 : 500,
        errorCode: refusalLog.logCtx.errorCode,
      });
      throw error;
    }
    if (workflow && !workflow.admitted) {
      budgetLease?.releaseUnused();
      lease.release();
      return withCors(await normalizeMessagesProxyRefusal(req, map(workflowDecisionRefusalResponse(workflow, undefined, refusalLog))), req, policy);
    }
    if (workflow?.admitted) lease.attach(workflow.lease);
    if (budgetLease) lease.attach({ release: () => budgetLease.releaseHoldOnly() });
    let handlerEntered = false;
    try {
      const response = await runAdmittedBodyWork(req, policy, configuredLimit(), () => {
        handlerEntered = true;
        if (refusalLog && budgetLease) refusalLog.logCtx.apiKeyBudgetLease = budgetLease;
        return work(lease);
      }, refusalLog,
      options?.mapRefusal, options?.onAdmissionError ? error => {
        if (!req.signal.aborted || error !== req.signal.reason) throw error;
        budgetLease?.releaseUnused();
        lease.release();
        if (refusalLog) {
          addFinalRequestLog(refusalLog.requestId, refusalLog.start, refusalLog.logCtx, 499, { closeReason: "client_cancel" });
          refusalLog.onLogged?.();
        }
        return withCors(map(options.onAdmissionError!(error)), req, policy);
      } : undefined);
      if (budgetLease && (!handlerEntered || wasRequestBodyRejected(req))) {
        budgetLease.releaseUnused();
      } else if (budgetLease && !lease.isTransferred() && !refusalLog) {
        budgetLease.releaseHoldOnly();
      }
      if (!lease.isTransferred()) lease.release();
      return response;
    } catch (error) {
      if (budgetLease) {
        if (!handlerEntered || wasRequestBodyRejected(req)) budgetLease.releaseUnused();
        else budgetLease.releaseHoldOnly();
      }
      lease.release();
      refusalLog?.logCtx.otlpSpan?.finish({
        status: req.signal.aborted ? 499 : 500,
        errorCode: refusalLog.logCtx.errorCode,
      });
      throw error;
    }
  };
}
