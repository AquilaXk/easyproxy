/**
 * The verify-account rotation must rebind the reasoning replay scope to the new
 * OAuth credential: a sibling retry that kept reading the failed account's scope
 * would replay thought signatures Google minted for a different credential.
 *
 * This drives `bindRouteReasoningReplayScope` and the signature store directly.
 * It is not the dispatch proof: the verify arm's A-to-B wire behavior is the
 * server test that replays a verify 403 onto the sibling account.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindRouteReasoningReplayScope } from "../../src/server/responses/core-replay";
import {
  lookupReplayThoughtSignature,
  rememberThoughtSignatureForReplay,
  resetThoughtSignatureReplayForTests,
} from "../../src/responses/thought-signature-replay";
import { commitReasoningReplayServingIdentity } from "../../src/responses/reasoning-replay-cache";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { EpxParsedRequest, EpxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SIG = "CiQAx-verify-rebind-signature-0123456789abcdef";

function parsedWithThread(): EpxParsedRequest {
  return {
    modelId: "gemini-3.8-flash",
    _reasoningReplayScope: { clientThreadId: "thread-verify-rebind" },
  } as EpxParsedRequest;
}

function antigravityProvider(): EpxProviderConfig {
  return {
    authMode: "oauth",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  } as unknown as EpxProviderConfig;
}

function bind(parsed: EpxParsedRequest, provider: EpxProviderConfig, accountId: string, generation: string): void {
  bindRouteReasoningReplayScope({
    parsed,
    providerName: "google-antigravity",
    provider,
    adapterName: "google",
    oauthCredentialSnapshot: { accountId, generation },
  });
}

describe("verify rotation reasoning replay scope", () => {
  let previousHome: string | undefined;
  let testDir: string;

  beforeEach(() => {
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "processed file: 1" }));
    setAsyncIcaclsRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: "processed file: 1" }));
    resetThoughtSignatureReplayForTests();
    previousHome = process.env.EASYPROXY_HOME;
    testDir = mkdtempSync(join(tmpdir(), "epx-verify-rebind-"));
    process.env.EASYPROXY_HOME = testDir;
  });

  afterEach(() => {
    resetThoughtSignatureReplayForTests();
    if (previousHome === undefined) delete process.env.EASYPROXY_HOME;
    else process.env.EASYPROXY_HOME = previousHome;
    removeTreeWithRetry(testDir);
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
  });

  test("rebinding A to B stops serving A signatures without wiping the store", () => {
    const parsed = parsedWithThread();
    const provider = antigravityProvider();
    bind(parsed, provider, "account-a", "generation-a");
    expect(rememberThoughtSignatureForReplay("call_verify_ab", SIG, parsed._reasoningReplayScope).result).toBe("stored");
    expect(lookupReplayThoughtSignature("call_verify_ab", parsed._reasoningReplayScope)).toBe(SIG);
    const aIdentity = { ...parsed._reasoningReplayScope!.current! };

    // Account A served this conversation before the refusal.
    commitReasoningReplayServingIdentity(parsed._reasoningReplayScope);

    bind(parsed, provider, "account-b", "generation-b");
    // The replay scope now belongs to B: A's signature is not served here.
    expect(lookupReplayThoughtSignature("call_verify_ab", parsed._reasoningReplayScope)).toBeUndefined();
    // The store itself is intact: A still resolves under A's identity (switch, not wipe).
    expect(lookupReplayThoughtSignature("call_verify_ab", {
      ...parsed._reasoningReplayScope!,
      current: aIdentity,
    })).toBe(SIG);
    // The serving-credential change also arms encrypted-content stripping so the
    // sibling retry cannot leak the failed scope's opaque reasoning payloads.
    expect(parsed._stripReasoningEncryptedContent).toBe(true);
  });
});
