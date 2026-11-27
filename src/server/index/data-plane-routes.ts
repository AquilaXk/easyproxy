import { formatErrorResponse } from "../../bridge";
import { isOtlpTracingEnabled, startOtlpRequestSpan } from "../../telemetry/otlp";
import type { EpxConfig } from "../../types";
import type { DataPlaneAdmission, RequestPolicyView } from "../auth-cors";
import { admissionFields, isAllowedRequestOrigin, resolveResponsesApiAuth, withCors } from "../auth-cors";
import type { RequestLogContext } from "../request-log";
import { classifyUsageClient } from "../../usage/client";

type JsonDataPlaneHandler = (
  req: Request,
  config: EpxConfig,
  logCtx: RequestLogContext,
  options: {
    requestId: string;
    start: number;
    admission?: DataPlaneAdmission;
    onRequestBodyRead?: () => void;
  },
) => Promise<Response>;

export interface JsonDataPlaneRouteContext {
  req: Request;
  url: URL;
  config: EpxConfig;
  policy: RequestPolicyView;
  isDraining: () => boolean;
  drainingResponse: (req: Request, policy: RequestPolicyView) => Response;
  nextRequestLogId: (start: number) => string;
  requestMetricsLogContext: Record<string, unknown>;
  runAdmittedHttpTurn: (
    req: Request,
    policy: RequestPolicyView,
    work: () => Promise<Response>,
    refusalLog?: { requestId: string; start: number; logCtx: RequestLogContext },
  ) => Promise<Response>;
  withRequestLogId: (response: Response, requestId: string) => Response;
  disableResponsesRequestTimeout: (req: Request) => void;
  protocol: "embeddings" | "rerank" | "audio";
  originBlockedMessage: string;
  handler: JsonDataPlaneHandler;
}

export async function handleJsonDataPlaneRoute(ctx: JsonDataPlaneRouteContext): Promise<Response> {
  const { req, url, config, policy } = ctx;
  if (ctx.isDraining()) return ctx.drainingResponse(req, policy);
  const admission = resolveResponsesApiAuth(req, policy);
  if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "easyproxy API key required"), req, policy);
  if (!isAllowedRequestOrigin(req, policy)) return withCors(formatErrorResponse(403, "origin_rejected", ctx.originBlockedMessage), req, policy);
  const start = Date.now();
  const requestId = ctx.nextRequestLogId(start);
  const logCtx = {
    model: "unknown",
    provider: "unknown",
    ...ctx.requestMetricsLogContext,
    client: classifyUsageClient(req.headers),
    ...admissionFields(admission),
    ...(isOtlpTracingEnabled(config) ? { otlpSpan: startOtlpRequestSpan(req, config, { method: req.method, pathname: url.pathname, protocol: ctx.protocol }) } : {}),
  } as RequestLogContext;
  return ctx.runAdmittedHttpTurn(req, policy, async () => {
    const response = withCors(
      await ctx.handler(req, config, logCtx, { requestId, start, admission, onRequestBodyRead: () => ctx.disableResponsesRequestTimeout(req) }),
      req,
      policy,
    );
    logCtx.otlpSpan?.finish({ status: response.status, errorCode: logCtx.errorCode });
    return ctx.withRequestLogId(response, requestId);
  }, { requestId, start, logCtx });
}
