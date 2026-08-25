import { act, fireEvent, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useTerminalTextSelection } from "./use-terminal-text-selection";

function pointerEvent(
  overrides: Partial<ReactPointerEvent<HTMLDivElement>> = {},
) {
  return {
    button: 0,
    clientX: 15,
    clientY: 15,
    currentTarget: {
      releasePointerCapture: vi.fn(),
      setPointerCapture: vi.fn(),
    },
    pointerId: 7,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as ReactPointerEvent<HTMLDivElement>;
}

describe("useTerminalTextSelection", () => {
  const writeText = vi.fn(() => Promise.resolve());
  const execCommand = vi.fn(() => false);

  beforeEach(() => {
    writeText.mockClear();
    execCommand.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
  });

  it("keeps a dragged range copyable when xterm clears its selection", async () => {
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () =>
      ({
        bottom: 240,
        height: 240,
        left: 0,
        right: 800,
        top: 0,
        width: 800,
      }) as DOMRect;
    const container = document.createElement("div");
    container.appendChild(screen);

    const select = vi.fn();
    let selection = "selected terminal text";
    const terminal = {
      buffer: { active: { viewportY: 20 } },
      clearSelection: vi.fn(),
      cols: 80,
      getSelection: () => selection,
      rows: 24,
      select,
    } as unknown as Terminal;
    const terminalRef = { current: terminal } as RefObject<Terminal | null>;
    const termRef = {
      current: container,
    } as RefObject<HTMLDivElement | null>;
    const { result } = renderHook(() =>
      useTerminalTextSelection({ terminalRef, termRef }),
    );

    act(() => result.current.toggleTextSelectionMode());
    expect(result.current.isTextSelectionMode).toBe(true);

    act(() => {
      result.current.handleSelectionPointerDown(pointerEvent());
      result.current.handleSelectionPointerMove(
        pointerEvent({ clientX: 45, clientY: 25 }),
      );
      result.current.syncTerminalSelection(terminal);
    });

    expect(select).toHaveBeenLastCalledWith(1, 21, 84);
    expect(result.current.hasTerminalSelection).toBe(true);

    selection = "";
    act(() => result.current.syncTerminalSelection(terminal));
    expect(result.current.hasTerminalSelection).toBe(true);

    await act(async () => {
      result.current.copyTerminalSelection();
    });

    expect(writeText).toHaveBeenCalledWith("selected terminal text");
    expect(result.current.copyStatus).toBe("copied");
    expect(result.current.isTextSelectionMode).toBe(false);
  });

  it("uses the browser copy event for Cmd+C", () => {
    const container = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () =>
      ({ height: 240, left: 0, top: 0, width: 800 }) as DOMRect;
    container.appendChild(screen);

    const terminal = {
      buffer: { active: { viewportY: 0 } },
      clearSelection: vi.fn(),
      cols: 80,
      getSelection: () => "native copy text",
      rows: 24,
      select: vi.fn(),
    } as unknown as Terminal;
    const { result } = renderHook(() =>
      useTerminalTextSelection({
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );

    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(pointerEvent());
    });

    const setData = vi.fn();
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: { setData },
    });

    act(() => {
      fireEvent.keyDown(document, { key: "c", metaKey: true });
      document.dispatchEvent(copyEvent);
    });

    expect(setData).toHaveBeenCalledWith("text/plain", "native copy text");
    expect(copyEvent.defaultPrevented).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(result.current.copyStatus).toBe("copied");
    expect(result.current.isTextSelectionMode).toBe(false);
  });
});
