import { act, cleanup, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useTerminalPaneEffects } from "./use-terminal-pane-effects";

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
