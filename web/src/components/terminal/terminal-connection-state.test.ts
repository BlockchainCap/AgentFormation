import { describe, expect, it } from "vitest";
import { getFollowUpConnectMode } from "./terminal-connection-state";

describe("terminal follow-up connections", () => {
  it("does not start a fallback after the connection generation changed", () => {
    expect(
      getFollowUpConnectMode({
        connectionId: 4,
        currentConnectionId: 5,
        fallbackToFreshSession: true,
        queuedConnectMode: null,
      }),
    ).toBeNull();
  });

  it("honors a reconnect queued after the connection generation changed", () => {
    expect(
      getFollowUpConnectMode({
        connectionId: 4,
        currentConnectionId: 5,
        fallbackToFreshSession: false,
        queuedConnectMode: "start",
      }),
    ).toBe("start");
  });

  it("prefers a current queued reconnect over a stale fallback", () => {
    expect(
      getFollowUpConnectMode({
        connectionId: 4,
        currentConnectionId: 5,
        fallbackToFreshSession: true,
        queuedConnectMode: "resume",
      }),
    ).toBe("resume");
  });

  it("prefers a fresh fallback for the current generation", () => {
    expect(
      getFollowUpConnectMode({
        connectionId: 5,
        currentConnectionId: 5,
        fallbackToFreshSession: true,
        queuedConnectMode: "resume",
      }),
    ).toBe("start");
  });

  it("keeps the queued mode when no fallback is needed", () => {
    expect(
      getFollowUpConnectMode({
        connectionId: 5,
        currentConnectionId: 5,
        fallbackToFreshSession: false,
        queuedConnectMode: "resume",
      }),
    ).toBe("resume");
  });
});
