import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fixturePath, repoPath } from "../helpers/repo-root";
import { EPX_CHILD_CARGO_RUN_MS, epxChildCargoTest, epxChildLinkWsCargoSkipped, epxChildToolchain } from "../helpers/epx-child-cargo";
import { linkWebsocketStateProof } from "../../src/link/relay-auth";

// epx-child's link WebSocket gate opens only in a build with the link-ws-test-gate Cargo
// feature. These checks keep that true for the builds operators make and keep both test runs wired.

const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as { scripts: Record<string, string> };
const cargo = readFileSync(repoPath("native/epx-child/Cargo.toml"), "utf8");

describe("epx-child link WebSocket test gate", () => {
  test("the Home's link WebSocket state proof matches the vectors epx-child's unit test checks", () => {
    const vectors = JSON.parse(readFileSync(fixturePath("link", "link-ws-state-proof.json"), "utf8")) as {
      cases: Array<{ fingerprint: string; keyId: string; linkId: string; nonce: string; value: "on"; proof: string }>;
    };
    expect(vectors.cases.length).toBeGreaterThanOrEqual(2);
    for (const c of vectors.cases) expect(linkWebsocketStateProof(c.fingerprint, c.keyId, c.linkId, c.nonce, c.value)).toBe(c.proof);
  });

  test("the distribution build passes no Cargo features", () => {
    expect(pkg.scripts["build:epx-child"]).toBe("cargo build --release --locked --manifest-path native/epx-child/Cargo.toml");
  });

  test("the feature is off by default and the gated integration target requires it", () => {
    expect(cargo).toMatch(/\[features\]\n(?:#.*\n)*link-ws-test-gate = \[\]/);
    expect(cargo).not.toMatch(/^default\s*=/m);
    expect(cargo).toMatch(/\[\[test\]\]\nname = "link_websocket"\nrequired-features = \["link-ws-test-gate"\]/);
  });

  test("the test script runs the crate without the feature (gate provably closed) and with it (the integration target)", () => {
    const script = pkg.scripts["test:epx-child"] ?? "";
    const runs = script.split("&&").map(part => part.trim());
    expect(runs).toEqual([
      "cargo test --locked --manifest-path native/epx-child/Cargo.toml",
      "cargo test --locked --manifest-path native/epx-child/Cargo.toml --features link-ws-test-gate",
    ]);
  });

  // CI reaches epx-child only through tests like these. This file makes the run without the feature;
  // link-epx-child-ws-feature.test.ts makes the one with it, so each Cargo run has a process to itself.
  test.skipIf(epxChildToolchain.bin === null || epxChildLinkWsCargoSkipped)("without the feature the link WebSocket unit tests pass and the gate stays closed (not on Windows, a precaution beside the link_websocket run)", () => {
    const out = epxChildCargoTest(["--lib", "link_ws"]);
    expect(out).toContain("link_ws_advert::tests::gate_stays_closed_without_the_test_feature ... ok");
  }, EPX_CHILD_CARGO_RUN_MS);
});
