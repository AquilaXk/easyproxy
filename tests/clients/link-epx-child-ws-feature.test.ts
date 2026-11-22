import { describe, expect, test } from "bun:test";
import { EPX_CHILD_CARGO_RUN_MS, epxChildCargoTest, epxChildLinkWsCargoSkipped, epxChildToolchain } from "../helpers/epx-child-cargo";

// The epx-child link WebSocket through the real binary, in a build with the link-ws-test-gate
// feature (native/epx-child/tests/link_websocket.rs). Its own file, so its Cargo run has a process to itself;
// the run without the feature is in link-epx-child-ws-gate.test.ts.

describe("epx-child link WebSocket with the test gate", () => {
  test.skipIf(epxChildToolchain.bin === null || epxChildLinkWsCargoSkipped)("the real-binary link WebSocket tests pass (not on Windows: the link_websocket target does not finish there)", () => {
    const out = epxChildCargoTest(["--features", "link-ws-test-gate", "--test", "link_websocket"]);
    expect(out).toContain("with_the_gate_an_advertising_home_carries_frames_both_ways ... ok");
  }, EPX_CHILD_CARGO_RUN_MS);
});
