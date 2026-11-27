import {
  canWriteProperty,
  CopyOnWriteMutator,
  writePropertySafe,
  type CopyOnWriteSegment,
} from "./mutable-json-copy";

export type OutboundSecretGuardMode = "off" | "redact" | "block";

export interface OutboundSecretGuardConfig {
  mode?: OutboundSecretGuardMode;
}

export interface OutboundSecretGuardResult {
  mode: OutboundSecretGuardMode;
  blocked: boolean;
  limitExceeded: boolean;
  matches: number;
  redactions: number;
  findings: string[];
  body?: unknown;
}

export const MAX_SECRET_SCAN_BYTES = 8 * 1024 * 1024;
export const MAX_SECRET_SCAN_DEPTH = 32;
export const MAX_SECRET_SCAN_NODES = 50_000;
const MAX_PEM_BLOCK_BYTES = 16 * 1024;

interface SecretRule {
  kind: string;
  mask: number;
  pattern: RegExp;
}

const RULE_PEM       = 1 << 0;
const RULE_OPENAI    = 1 << 1;
const RULE_ANTHROPIC = 1 << 2;
const RULE_GITHUB    = 1 << 3;
const RULE_AWS       = 1 << 4;
const RULE_GOOGLE    = 1 << 5;
const RULE_EPX       = 1 << 6;
const RULE_SLACK     = 1 << 7;

// High-confidence token prefixes with strictly non-backtracking character classes.
const SECRET_RULES: readonly SecretRule[] = [
  { kind: "openai_key", mask: RULE_OPENAI, pattern: /\bsk-(?:proj|live)-[A-Za-z0-9_-]{20,}/g },
  { kind: "anthropic_key", mask: RULE_ANTHROPIC, pattern: /\bsk-ant-api03-[A-Za-z0-9_-]{20,}/g },
  { kind: "github_token", mask: RULE_GITHUB, pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: "aws_access_key", mask: RULE_AWS, pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "google_api_key", mask: RULE_GOOGLE, pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "easyproxy_token", mask: RULE_EPX, pattern: /\bepx_(?:data|admin|session|pair)_[A-Za-z0-9_-]{16,}/g },
  { kind: "slack_token", mask: RULE_SLACK, pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
];

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]{0,24}PRIVATE KEY-----/;

// Minimum length across all SECRET_RULES and PEM headers is 15 chars (`xox[baprs]-[A-Za-z0-9-]{10,}`).
const MIN_SECRET_CANDIDATE_CHARS = 14;

/**
 * 16 KiB L1-resident ASCII 2-char prefix dispatch table.
 * Stores rule hint bits for candidate 2-byte prefixes so common words ("git", "--flag", "skill")
 * get rejected immediately by 4-byte inline verification with zero RegExp execution.
 */
const SECRET_PAIR_DISPATCH = (() => {
  const table = new Uint8Array(16_384);
  const entries: ReadonlyArray<readonly [string, number]> = [
    ["--", RULE_PEM],
    ["sk", RULE_OPENAI | RULE_ANTHROPIC],
    ["gh", RULE_GITHUB],
    ["gi", RULE_GITHUB],
    ["AK", RULE_AWS],
    ["AI", RULE_GOOGLE],
    ["ep", RULE_EPX],
    ["xo", RULE_SLACK],
  ];
  for (const [pair, mask] of entries) {
    const idx = ((pair.charCodeAt(0) & 0x7f) << 7) | (pair.charCodeAt(1) & 0x7f);
    table[idx] |= mask;
  }
  return table;
})();

function verifySecretPrefixMask(value: string, len: number, secondIndex: number, hint: number): number {
  if (secondIndex + 2 >= len) return 0;
  const c0 = value.charCodeAt(secondIndex - 1);
  const c1 = value.charCodeAt(secondIndex);
  const c2 = value.charCodeAt(secondIndex + 1);
  const c3 = value.charCodeAt(secondIndex + 2);
  if ((hint & RULE_PEM) !== 0 && c0 === 0x2d && c1 === 0x2d) {
    return c2 === 0x2d && c3 === 0x2d ? RULE_PEM : 0;
  }
  if ((hint & (RULE_OPENAI | RULE_ANTHROPIC)) !== 0 && c0 === 0x73 && c1 === 0x6b) {
    if (c2 !== 0x2d) return 0;
    if (c3 === 0x70 || c3 === 0x6c) return RULE_OPENAI;
    if (c3 === 0x61) return RULE_ANTHROPIC;
    return 0;
  }
  if ((hint & RULE_GITHUB) !== 0) {
    if (c0 === 0x67 && c1 === 0x68) {
      return (c2 === 0x70 || c2 === 0x6f || c2 === 0x75 || c2 === 0x73 || c2 === 0x72) && c3 === 0x5f
        ? RULE_GITHUB
        : 0;
    }
    if (c0 === 0x67 && c1 === 0x69) {
      return c2 === 0x74 && c3 === 0x68 && secondIndex + 3 < len && value.charCodeAt(secondIndex + 3) === 0x75
        ? RULE_GITHUB
        : 0;
    }
  }
  if ((hint & RULE_AWS) !== 0 && c0 === 0x41 && c1 === 0x4b) {
    return c2 === 0x49 && c3 === 0x41 ? RULE_AWS : 0;
  }
  if ((hint & RULE_GOOGLE) !== 0 && c0 === 0x41 && c1 === 0x49) {
    return c2 === 0x7a && c3 === 0x61 ? RULE_GOOGLE : 0;
  }
  if ((hint & RULE_EPX) !== 0 && c0 === 0x65 && c1 === 0x70) {
    return c2 === 0x78 && c3 === 0x5f ? RULE_EPX : 0;
  }
  if ((hint & RULE_SLACK) !== 0 && c0 === 0x78 && c1 === 0x6f) {
    return c2 === 0x78 && (c3 === 0x62 || c3 === 0x61 || c3 === 0x70 || c3 === 0x72 || c3 === 0x73)
      ? RULE_SLACK
      : 0;
  }
  return 0;
}

function measureAndCheckSecretCandidate(value: string): { utf8Bytes: number; ruleMask: number } {
  const len = value.length;
  let nonAscii = 0;
  if (len === 0) return { utf8Bytes: 0, ruleMask: 0 };
  if (len < MIN_SECRET_CANDIDATE_CHARS) {
    for (let i = 0; i < len; i += 1) nonAscii |= value.charCodeAt(i);
    return {
      utf8Bytes: (nonAscii & ~0x7f) === 0 ? len : Buffer.byteLength(value, "utf8"),
      ruleMask: 0,
    };
  }
  let ruleMask = 0;
  let prev = value.charCodeAt(0);
  nonAscii |= prev;
  for (let i = 1; i < len; i += 1) {
    const cur = value.charCodeAt(i);
    nonAscii |= cur;
    if (((prev | cur) & ~0x7f) === 0) {
      const hint = SECRET_PAIR_DISPATCH[(prev << 7) | cur]!;
      if (hint !== 0) {
        ruleMask |= verifySecretPrefixMask(value, len, i, hint);
      }
    }
    prev = cur;
  }
  return {
    utf8Bytes: (nonAscii & ~0x7f) === 0 ? len : Buffer.byteLength(value, "utf8"),
    ruleMask,
  };
}

function scanAndTransformString(
  input: string,
  redact: boolean,
  findings: Set<string>,
  ruleMask: number,
): { next: string; matches: number; redactions: number } {
  let current = input;
  let matches = 0;
  let redactions = 0;

  if ((ruleMask & RULE_PEM) !== 0 && current.includes("-----BEGIN ")) {
    for (;;) {
      const headerMatch = PEM_BEGIN_RE.exec(current);
      if (!headerMatch) break;
      matches += 1;
      findings.add("pem_private_key");
      if (!redact) break;
      const start = headerMatch.index;
      const endTagPos = current.indexOf("-----END ", start + headerMatch[0].length);
      let sliceEnd = start + headerMatch[0].length;
      if (endTagPos !== -1 && endTagPos - start <= MAX_PEM_BLOCK_BYTES) {
        const closingDashes = current.indexOf("-----", endTagPos + 9);
        if (closingDashes !== -1 && closingDashes - start <= MAX_PEM_BLOCK_BYTES) {
          sliceEnd = closingDashes + 5;
        }
      }
      current = `${current.slice(0, start)}[REDACTED:pem_private_key]${current.slice(sliceEnd)}`;
      redactions += 1;
    }
  }

  for (const rule of SECRET_RULES) {
    if ((ruleMask & rule.mask) === 0) continue;
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(current)) continue;
    findings.add(rule.kind);
    if (redact) {
      rule.pattern.lastIndex = 0;
      current = current.replace(rule.pattern, () => {
        matches += 1;
        redactions += 1;
        return `[REDACTED:${rule.kind}]`;
      });
    } else {
      rule.pattern.lastIndex = 0;
      while (rule.pattern.exec(current) !== null) {
        matches += 1;
      }
    }
  }

  return { next: current, matches, redactions };
}

interface GuardFrame {
  container: unknown;
  depth: number;
  parent: GuardFrame | null;
  parentKey: string | number | undefined;
  protectedAncestor: boolean;
}

function buildCopyOnWritePath(leaf: GuardFrame, leafKey: string | number): CopyOnWriteSegment[] {
  const path: CopyOnWriteSegment[] = [];
  let cur: GuardFrame | null = leaf;
  let key: string | number = leafKey;
  while (cur !== null && typeof cur.container === "object" && cur.container !== null) {
    path.push({ container: cur.container, key });
    if (cur.parent === null || cur.parentKey === undefined) break;
    key = cur.parentKey;
    cur = cur.parent;
  }
  path.reverse();
  return path;
}

interface AliasedBackEdge {
  parent: GuardFrame;
  key: string | number;
  target: object;
}

function reconcileAliasedBackEdges(
  mutator: CopyOnWriteMutator,
  backEdges: readonly AliasedBackEdge[],
): void {
  if (!mutator.hasClones || backEdges.length === 0) return;
  let changed = true;
  let passes = 0;
  while (changed && passes <= backEdges.length) {
    changed = false;
    passes += 1;
    for (const edge of backEdges) {
      const resolvedTarget = mutator.resolve(edge.target);
      if (resolvedTarget === edge.target) continue;
      const before = mutator.resolve(edge.parent.container as object);
      mutator.write(buildCopyOnWritePath(edge.parent, edge.key), resolvedTarget);
      if (mutator.resolve(edge.parent.container as object) !== before) {
        changed = true;
      }
    }
  }
}

/**
 * Inspects an outbound JSON request body for leaked secrets using a bounded,
 * non-recursive traversal. Fails closed in `"block"` mode when traversal bounds
 * (depth, nodes, or byte budget) are exceeded.
 */
export function inspectAndApplyOutboundSecretGuard(
  body: unknown,
  config?: OutboundSecretGuardConfig,
): OutboundSecretGuardResult {
  const mode: OutboundSecretGuardMode = config?.mode === "redact" || config?.mode === "block"
    ? config.mode
    : "off";
  if (mode === "off" || body === null || body === undefined) {
    return { mode, blocked: false, limitExceeded: false, matches: 0, redactions: 0, findings: [], body };
  }

  const redact = mode === "redact";
  const originalBody: unknown = body;
  const mutator = redact ? new CopyOnWriteMutator(body) : undefined;
  const findings = new Set<string>();
  const visited = new WeakSet<object>();
  const backEdges: AliasedBackEdge[] = [];
  const stack: GuardFrame[] = [{
    container: body,
    depth: 0,
    parent: null,
    parentKey: undefined,
    protectedAncestor: false,
  }];
  let nodes = 0;
  let scannedBytes = 0;
  let matches = 0;
  let redactions = 0;

  const finalizeRedactedBody = (includeRemainingStack: boolean): unknown => {
    if (!redact || redactions === 0) return originalBody;
    if (includeRemainingStack && mutator!.hasClones) {
      for (const pending of stack) {
        if (
          typeof pending.container === "object" && pending.container !== null
          && pending.parent !== null && pending.parentKey !== undefined
        ) {
          backEdges.push({ parent: pending.parent, key: pending.parentKey, target: pending.container });
        }
      }
    }
    reconcileAliasedBackEdges(mutator!, backEdges);
    return mutator!.root;
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { container, depth } = frame;
    if (depth > MAX_SECRET_SCAN_DEPTH || nodes >= MAX_SECRET_SCAN_NODES || scannedBytes > MAX_SECRET_SCAN_BYTES) {
      if (mode === "block") findings.add("scan_budget_exceeded");
      return {
        mode,
        blocked: mode === "block",
        limitExceeded: true,
        matches,
        redactions,
        findings: [...findings],
        body: finalizeRedactedBody(true),
      };
    }

    if (typeof container !== "object" || container === null) continue;
    if (visited.has(container)) {
      if (redact && frame.parent !== null && frame.parentKey !== undefined) {
        backEdges.push({ parent: frame.parent, key: frame.parentKey, target: container });
      }
      continue;
    }
    visited.add(container);

    const frameProtected = redact
      && (frame.protectedAncestor || Object.isFrozen(container) || !Object.isExtensible(container));

    if (Array.isArray(container)) {
      for (let i = 0; i < container.length; i += 1) {
        nodes += 1;
        if (nodes > MAX_SECRET_SCAN_NODES) {
          if (mode === "block") findings.add("scan_budget_exceeded");
          return {
            mode,
            blocked: mode === "block",
            limitExceeded: true,
            matches,
            redactions,
            findings: [...findings],
            body: finalizeRedactedBody(true),
          };
        }
        const value = container[i];
        if (typeof value === "string") {
          if (scannedBytes + value.length > MAX_SECRET_SCAN_BYTES) {
            if (mode === "block") findings.add("scan_budget_exceeded");
            return {
              mode,
              blocked: mode === "block",
              limitExceeded: true,
              matches,
              redactions,
              findings: [...findings],
              body: finalizeRedactedBody(true),
            };
          }
          const pre = measureAndCheckSecretCandidate(value);
          scannedBytes += pre.utf8Bytes;
          if (scannedBytes > MAX_SECRET_SCAN_BYTES) {
            if (mode === "block") findings.add("scan_budget_exceeded");
            return {
              mode,
              blocked: mode === "block",
              limitExceeded: true,
              matches,
              redactions,
              findings: [...findings],
              body: finalizeRedactedBody(true),
            };
          }
          if (pre.ruleMask === 0) continue;
          const result = scanAndTransformString(value, redact, findings, pre.ruleMask);
          matches += result.matches;
          redactions += result.redactions;
          if (redact && result.next !== value) {
            if (!frameProtected && canWriteProperty(container, i) && mutator!.resolve(container) === container) {
              container[i] = result.next;
            } else {
              mutator!.write(buildCopyOnWritePath(frame, i), result.next);
            }
          }
          if (mode === "block" && matches > 0) {
            return {
              mode,
              blocked: true,
              limitExceeded: false,
              matches,
              redactions: 0,
              findings: [...findings],
              body: originalBody,
            };
          }
        } else if (value && typeof value === "object") {
          stack.push({
            container: value,
            depth: depth + 1,
            parent: frame,
            parentKey: i,
            protectedAncestor: frameProtected,
          });
        }
      }
      continue;
    }

    const record = container as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      nodes += 1;
      if (nodes > MAX_SECRET_SCAN_NODES) {
        if (mode === "block") findings.add("scan_budget_exceeded");
        return {
          mode,
          blocked: mode === "block",
          limitExceeded: true,
          matches,
          redactions,
          findings: [...findings],
          body: finalizeRedactedBody(true),
        };
      }
      const value = record[key];
      if (typeof value === "string") {
        if (scannedBytes + value.length > MAX_SECRET_SCAN_BYTES) {
          if (mode === "block") findings.add("scan_budget_exceeded");
          return {
            mode,
            blocked: mode === "block",
            limitExceeded: true,
            matches,
            redactions,
            findings: [...findings],
            body: finalizeRedactedBody(true),
          };
        }
        const pre = measureAndCheckSecretCandidate(value);
        scannedBytes += pre.utf8Bytes;
        if (scannedBytes > MAX_SECRET_SCAN_BYTES) {
          if (mode === "block") findings.add("scan_budget_exceeded");
          return {
            mode,
            blocked: mode === "block",
            limitExceeded: true,
            matches,
            redactions,
            findings: [...findings],
            body: finalizeRedactedBody(true),
          };
        }
        if (pre.ruleMask === 0) continue;
        const result = scanAndTransformString(value, redact, findings, pre.ruleMask);
        matches += result.matches;
        redactions += result.redactions;
        if (redact && result.next !== value) {
          if (!frameProtected && canWriteProperty(record, key) && mutator!.resolve(record) === record) {
            writePropertySafe(record, key, result.next);
          } else {
            mutator!.write(buildCopyOnWritePath(frame, key), result.next);
          }
        }
        if (mode === "block" && matches > 0) {
          return {
            mode,
            blocked: true,
            limitExceeded: false,
            matches,
            redactions: 0,
            findings: [...findings],
            body: originalBody,
          };
        }
      } else if (value && typeof value === "object") {
        stack.push({
          container: value,
          depth: depth + 1,
          parent: frame,
          parentKey: key,
          protectedAncestor: frameProtected,
        });
      }
    }
  }

  return {
    mode,
    blocked: mode === "block" && matches > 0,
    limitExceeded: false,
    matches,
    redactions,
    findings: [...findings],
    body: finalizeRedactedBody(false),
  };
}
