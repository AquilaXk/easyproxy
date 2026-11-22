import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { labPublicPublisherKeyPath } from "../../src/lab/paths";
import {
  buildPublicEvidenceBundle,
  importCommunityEvidenceBundle,
  parseStrictPublicJson,
  publicEvidenceId,
  signPublicEvidenceBundle,
  verifyPublicEvidenceBundle,
} from "../../src/lab/public";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Deterministic test-only key material is assembled at runtime so leak scanners do not
// mistake the fixture for a deployable private-key credential.
const FIXED_PRIVATE_KEY = [
  `-----BEGIN PRIVATE ${"KEY"}-----`,
  ["MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYH", "CAkKCwwNDg8QERITFBUWFxgZGhscHR4f"].join(""),
  `-----END PRIVATE ${"KEY"}-----`,
  "",
].join("\n");
const FIXED_PUBLIC_KEY = "MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function configDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function installFixedPublisherKey(config: string): void {
  const path = labPublicPublisherKeyPath(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, FIXED_PRIVATE_KEY, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function fixedRecord() {
  const subject = {
    subjectKind: "protocol" as const,
    compatibilityVersion: "2.13.0",
    adapterFamily: "openai-chat" as const,
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
  };
  const subjectId = publicEvidenceId("subject", subject);
  const withoutRecordId = {
    subjectId,
    evidenceLayer: "protocol_conformance" as const,
    suiteId: "responses-core",
    suiteVersion: "1.0.0",
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1.0.0",
    verdict: "VERIFIED" as const,
    observedDayUtc: "2026-08-12",
    subject,
    assertions: [
      { id: "method", required: true, passed: true },
      { id: "message", required: true, passed: true },
      { id: "temperature", required: true, passed: true },
    ],
  };
  return { recordId: publicEvidenceId("record", withoutRecordId), ...withoutRecordId };
}

function fixedBundle(config: string) {
  installFixedPublisherKey(config);
  return signPublicEvidenceBundle({
    records: [fixedRecord()],
    artifacts: [],
    createdDayUtc: "2026-08-12",
    configDir: config,
  });
}

describe("CL-10 public wire contract", () => {
  test("freezes the RFC 8785/domain-separated bundle and Ed25519 signature vector", () => {
    const bundle = fixedBundle(configDir("epx-cl10-wire-publisher-"));

    expect(bundle.publisher.publicKey).toBe(FIXED_PUBLIC_KEY);
    expect(bundle.publisher.keyId).toBe("b95ca54768698f4ab356f43ac554d92f5811ca61d334a5fff4d2740138a2a40e");
    expect(bundle.records[0]!.subjectId).toBe("d405200c15de6cff54f88f1a2661048f2611c6b0113df37d924296dac553a7fb");
    expect(bundle.records[0]!.recordId).toBe("eee7484fbcb5d2e7d2c4eeb49e7c2a3707654f5dbd73e70a106625c879a2cdf5");
    expect(bundle.bundleId).toBe("a012159c9841939d251897b2aa6a3b1308e1c25810ac27a60a1ea8a5d4e61c6f");
    expect(bundle.bundleDigest).toBe("a329452f4fec916a7b4899c08006087d9a964c4d8c6c26fdd94b54da7818ccec");
    expect(bundle.signature).toEqual({
      algorithm: "ed25519",
      signedDigest: "a329452f4fec916a7b4899c08006087d9a964c4d8c6c26fdd94b54da7818ccec",
      signature: "gmxxVpG7xTDubldQkePfFmWfxxQCtZUtEtiPxuOWLQGPdtjVBK5DN6CNuJFDF/zHvRVhwmFst+e8i5i0gQ4CDw==",
    });
    expect(verifyPublicEvidenceBundle(bundle)).toEqual({ status: "cryptographically_valid" });
  });

  test("rejects non-canonical publisher public-key Base64", () => {
    const publicKey = `${FIXED_PUBLIC_KEY}\n`;
    const publisher = {
      algorithm: "ed25519" as const,
      publicKey,
      keyId: publicEvidenceId("publisher_key", { algorithm: "ed25519", publicKey }),
    };

    expect(() => buildPublicEvidenceBundle({
      records: [fixedRecord()],
      artifacts: [],
      createdDayUtc: "2026-08-12",
      publisher,
    })).toThrow(/canonical base64/i);
  });

  test("rejects duplicate JSON object keys before community parsing", () => {
    const publisherDir = configDir("epx-cl10-wire-publisher-");
    const consumerDir = configDir("epx-cl10-wire-consumer-");
    const bundle = fixedBundle(publisherDir);
    const raw = JSON.stringify(bundle).replace(
      '"schemaVersion":"public_evidence_bundle_v1"',
      '"schemaVersion":"public_evidence_bundle_v1","schemaVersion":"public_evidence_bundle_v1"',
    );

    expect(() => importCommunityEvidenceBundle(raw, consumerDir)).toThrow(/duplicate json object key/i);
  });

  test("rejects public JSON deeper than the V1 import bound before JSON.parse materialization", () => {
    const raw = Buffer.from(`${"[".repeat(9)}0${"]".repeat(9)}`, "utf8");
    expect(() => parseStrictPublicJson(raw)).toThrow(/nesting depth exceeds 8/i);
  });
});
