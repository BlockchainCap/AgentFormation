import { act, cleanup, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { beaconTerminateSession } from "./terminal-api";
import { useTerminalPaneEffects } from "./use-terminal-pane-effects";

vi.mock("./terminal-api", () => ({
  beaconTerminateSession: vi.fn(),
}));

function touchEvent(
  type: "touchstart" | "touchmove",
  clientX: number,
  clientY: number,
): TouchEvent {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "touches", {
    value: [{ clientX, clientY }],
  });
  return event as TouchEvent;
}

describe("useTerminalPaneEffects", () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.mocked(beaconTerminateSession).mockReset();
  });

  it("keeps the terminal attached while the page is backgrounded", () => {
    const reconnectIfNeeded = vi.fn();
    const resetTransport = vi.fn();
    const sessionRef = {
      current: {
        sessionId: "session-1",
        streamUrl:
          "wss://ssmmessages.us-east-1.amazonaws.com/v1/data-channel/session-1",
        tokenValue: "token",
        terminateToken: "terminate-token",
      },
    };
    const visibilityState = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");

    renderHook(() =>
      useTerminalPaneEffects({
        connect: vi.fn().mockResolvedValue(undefined),
        dpadPosition: null,
        isActive: false,
        reconnectIfNeeded,
        resetTransport,
        scheduleTerminalSizeBurst: vi.fn(),
        scrollRef: { current: null },
        sessionRef,
        setDpadPosition: vi.fn(),
        setTerminalHeight: vi.fn(),
        state: "connected",
        termRef: { current: null },
        terminalRef: { current: null },
        updateTerminalReviewState: vi.fn(() => false),
      }),
    );

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(resetTransport).not.toHaveBeenCalled();
    expect(beaconTerminateSession).not.toHaveBeenCalled();
    expect(sessionRef.current?.sessionId).toBe("session-1");

    visibilityState.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new PageTransitionEvent("pageshow"));
    });

    expect(reconnectIfNeeded).toHaveBeenCalledTimes(2);
  });

  it("terminates the session only when the browser actually unloads", () => {
    const resetTransport = vi.fn();
    const sessionRef = {
      current: {
        sessionId: "session-1",
        streamUrl:
          "wss://ssmmessages.us-east-1.amazonaws.com/v1/data-channel/session-1",
        tokenValue: "token",
        terminateToken: "terminate-token",
      },
    };

    renderHook(() =>
      useTerminalPaneEffects({
        connect: vi.fn().mockResolvedValue(undefined),
        dpadPosition: null,
        isActive: false,
        reconnectIfNeeded: vi.fn(),
        resetTransport,
        scheduleTerminalSizeBurst: vi.fn(),
        scrollRef: { current: null },
        sessionRef,
        setDpadPosition: vi.fn(),
        setTerminalHeight: vi.fn(),
        state: "connected",
        termRef: { current: null },
        terminalRef: { current: null },
        updateTerminalReviewState: vi.fn(() => false),
      }),
    );

    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });

    expect(beaconTerminateSession).toHaveBeenCalledWith(
      "session-1",
      "terminate-token",
    );
    expect(resetTransport).not.toHaveBeenCalled();
  });

  it("passes a vertical touch swipe through xterm as a wheel event", () => {
    const scrollContainer = document.createElement("div");
    const terminalContainer = document.createElement("div");
    const terminalElement = document.createElement("div");
    document.body.append(scrollContainer, terminalContainer, terminalElement);
    const wheelEvents: WheelEvent[] = [];
    terminalElement.addEventListener("wheel", (event) => {
      wheelEvents.push(event);
    });
    const scrollLines = vi.fn();
    const terminal = {
      element: terminalElement,
      scrollLines,
    } as unknown as Terminal;

    renderHook(() =>
      useTerminalPaneEffects({
        connect: vi.fn().mockResolvedValue(undefined),
        dpadPosition: { x: 0, y: 0 },
        isActive: true,
        reconnectIfNeeded: vi.fn(),
        resetTransport: vi.fn(),
        scheduleTerminalSizeBurst: vi.fn(),
        scrollRef: { current: scrollContainer } as RefObject<HTMLDivElement>,
        sessionRef: { current: null },
        setDpadPosition: vi.fn(),
        setTerminalHeight: vi.fn(),
        state: "connected",
        termRef: { current: terminalContainer } as RefObject<HTMLDivElement>,
        terminalRef: { current: terminal },
        updateTerminalReviewState: vi.fn(() => true),
      }),
    );

    act(() => {
      scrollContainer.dispatchEvent(touchEvent("touchstart", 80, 100));
      scrollContainer.dispatchEvent(touchEvent("touchmove", 80, 70));
    });

    expect(wheelEvents).toHaveLength(1);
    expect(wheelEvents[0]).toMatchObject({
      clientX: 80,
      clientY: 70,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: 2,
    });
    expect(scrollLines).not.toHaveBeenCalled();
  });
});
