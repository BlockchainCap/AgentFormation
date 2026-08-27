import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useTerminalTextSelection } from "./use-terminal-text-selection";

function pointerEvent(
  overrides: Partial<ReactPointerEvent<HTMLDivElement>> = {},
) {
  const currentTarget = document.createElement("div");
  currentTarget.className = "terminal-selection-surface";
  currentTarget.tabIndex = -1;
  currentTarget.releasePointerCapture = vi.fn();
  currentTarget.setPointerCapture = vi.fn();
  document.body.appendChild(currentTarget);
  return {
    button: 0,
    clientX: 15,
    clientY: 15,
    currentTarget,
    pointerId: 7,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as ReactPointerEvent<HTMLDivElement>;
}

describe("useTerminalTextSelection", () => {
  const writeText = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
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
      useTerminalTextSelection({ isActive: true, terminalRef, termRef }),
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
    expect(result.current.hasTerminalSelection).toBe(false);
  });

  it("clears cached text when the active drag shrinks to an empty range", async () => {
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () =>
      ({ height: 240, left: 0, top: 0, width: 800 }) as DOMRect;
    const container = document.createElement("div");
    container.appendChild(screen);
    let selection = "text selected earlier in the drag";
    const terminal = {
      buffer: { active: { viewportY: 0 } },
      clearSelection: vi.fn(),
      cols: 80,
      getSelection: () => selection,
      rows: 24,
      select: vi.fn(),
    } as unknown as Terminal;
    const { result } = renderHook(() =>
      useTerminalTextSelection({
        isActive: true,
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );
    const pointer = pointerEvent();

    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(pointer);
    });
    expect(result.current.hasTerminalSelection).toBe(true);

    selection = "";
    act(() => {
      result.current.handleSelectionPointerMove(
        pointerEvent({ clientX: 45, pointerId: pointer.pointerId }),
      );
    });
    expect(result.current.hasTerminalSelection).toBe(false);

    await act(async () => result.current.copyTerminalSelection());
    expect(writeText).not.toHaveBeenCalled();
  });

  it("uses the verified Clipboard API path for Cmd+C", async () => {
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
        isActive: true,
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );

    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(pointerEvent());
    });

    await act(async () => {
      fireEvent.keyDown(document, { key: "c", metaKey: true });
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("native copy text");
    expect(result.current.copyStatus).toBe("copied");
    expect(result.current.isTextSelectionMode).toBe(false);
  });

  it("copies the preserved terminal text when the Copy button has focus", async () => {
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
      getSelection: () => "button copy text",
      rows: 24,
      select: vi.fn(),
    } as unknown as Terminal;
    const { result } = renderHook(() =>
      useTerminalTextSelection({
        isActive: true,
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );
    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(pointerEvent());
    });

    const copyButton = document.createElement("button");
    document.body.appendChild(copyButton);
    copyButton.focus();
    await act(async () => {
      result.current.copyTerminalSelection();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("button copy text");
    expect(result.current.copyStatus).toBe("copied");
    expect(result.current.isTextSelectionMode).toBe(false);
  });

  it("keeps the selection and reports an error when clipboard writing fails", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard blocked"));
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
      getSelection: () => "retry this selection",
      rows: 24,
      select: vi.fn(),
    } as unknown as Terminal;
    const { result } = renderHook(() =>
      useTerminalTextSelection({
        isActive: true,
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );
    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(pointerEvent());
    });

    await act(async () => {
      result.current.copyTerminalSelection();
      await Promise.resolve();
    });

    expect(result.current.copyStatus).toBe("error");
    expect(result.current.hasTerminalSelection).toBe(true);
    expect(result.current.isTextSelectionMode).toBe(true);
  });

  it("removes document copy shortcuts when the pane unmounts", async () => {
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
      getSelection: () => "detached selection",
      rows: 24,
      select: vi.fn(),
    } as unknown as Terminal;
    const { result, unmount } = renderHook(() =>
      useTerminalTextSelection({
        isActive: true,
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );
    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(pointerEvent());
    });
    unmount();
    writeText.mockClear();

    await act(async () => {
      fireEvent.keyDown(document, { key: "c", metaKey: true });
      await Promise.resolve();
    });

    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not reuse text from an earlier drag when a new drag is empty", async () => {
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () =>
      ({ height: 240, left: 0, top: 0, width: 800 }) as DOMRect;
    const container = document.createElement("div");
    container.appendChild(screen);
    let selection = "old selection";
    const terminal = {
      buffer: { active: { viewportY: 0 } },
      clearSelection: vi.fn(),
      cols: 80,
      getSelection: () => selection,
      rows: 24,
      select: vi.fn(),
    } as unknown as Terminal;
    const { result } = renderHook(() =>
      useTerminalTextSelection({
        isActive: true,
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );

    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(pointerEvent());
      result.current.handleSelectionPointerUp(pointerEvent());
    });
    expect(result.current.hasTerminalSelection).toBe(true);

    selection = "";
    act(() => result.current.handleSelectionPointerDown(pointerEvent()));
    expect(result.current.hasTerminalSelection).toBe(false);

    await act(async () => result.current.copyTerminalSelection());
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not intercept a copy from outside the active terminal selection surface", () => {
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
      getSelection: () => "terminal text",
      rows: 24,
      select: vi.fn(),
    } as unknown as Terminal;
    const { result } = renderHook(() =>
      useTerminalTextSelection({
        isActive: true,
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );
    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(pointerEvent());
    });
    const outsideInput = document.createElement("input");
    document.body.appendChild(outsideInput);
    outsideInput.focus();
    const setData = vi.fn();
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: { setData },
    });

    act(() => document.dispatchEvent(copyEvent));

    expect(copyEvent.defaultPrevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });

  it("does not hijack a keyboard copy while ordinary input has focus", async () => {
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
      getSelection: () => "terminal text",
      rows: 24,
      select: vi.fn(),
    } as unknown as Terminal;
    const { result } = renderHook(() =>
      useTerminalTextSelection({
        isActive: true,
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );
    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(pointerEvent());
    });
    const outsideInput = document.createElement("input");
    document.body.appendChild(outsideInput);
    outsideInput.focus();

    const copied = fireEvent.keyDown(outsideInput, {
      key: "c",
      metaKey: true,
    });
    await act(async () => Promise.resolve());

    expect(copied).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(result.current.isTextSelectionMode).toBe(true);
  });

  it("stops extending a drag after pointer cancellation", () => {
    const container = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () =>
      ({ height: 240, left: 0, top: 0, width: 800 }) as DOMRect;
    container.appendChild(screen);
    const select = vi.fn();
    const terminal = {
      buffer: { active: { viewportY: 0 } },
      clearSelection: vi.fn(),
      cols: 80,
      getSelection: () => "terminal text",
      rows: 24,
      select,
    } as unknown as Terminal;
    const { result } = renderHook(() =>
      useTerminalTextSelection({
        isActive: true,
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );
    const pointer = pointerEvent();
    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(pointer);
      result.current.handleSelectionPointerCancel(pointer);
      result.current.handleSelectionPointerMove(
        pointerEvent({ clientX: 100, pointerId: pointer.pointerId }),
      );
    });

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("ignores a second pointer while a selection drag is active", () => {
    const container = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () =>
      ({ height: 240, left: 0, top: 0, width: 800 }) as DOMRect;
    container.appendChild(screen);
    const select = vi.fn();
    const clearSelection = vi.fn();
    const terminal = {
      buffer: { active: { viewportY: 0 } },
      clearSelection,
      cols: 80,
      getSelection: () => "terminal text",
      rows: 24,
      select,
    } as unknown as Terminal;
    const { result } = renderHook(() =>
      useTerminalTextSelection({
        isActive: true,
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );
    const firstPointer = pointerEvent({ pointerId: 7 });
    const secondPointer = pointerEvent({ pointerId: 8 });

    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(firstPointer);
      result.current.handleSelectionPointerDown(secondPointer);
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(clearSelection).toHaveBeenCalledTimes(2);
    expect(
      secondPointer.currentTarget.setPointerCapture,
    ).not.toHaveBeenCalled();
  });

  it("keeps the selection and reports an error without Clipboard API access", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
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
      getSelection: () => "clipboard fallback text",
      rows: 24,
      select: vi.fn(),
    } as unknown as Terminal;
    const { result } = renderHook(() =>
      useTerminalTextSelection({
        isActive: true,
        terminalRef: { current: terminal },
        termRef: { current: container },
      }),
    );

    act(() => {
      result.current.toggleTextSelectionMode();
      result.current.handleSelectionPointerDown(pointerEvent());
      result.current.copyTerminalSelection();
    });

    expect(result.current.copyStatus).toBe("error");
    expect(result.current.hasTerminalSelection).toBe(true);
    expect(result.current.isTextSelectionMode).toBe(true);
  });

  it("clears selection state when the pane becomes inactive", () => {
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    try {
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
        getSelection: () => "terminal text",
        rows: 24,
        select: vi.fn(),
      } as unknown as Terminal;
      const { result, rerender } = renderHook(
        ({ isActive }) =>
          useTerminalTextSelection({
            isActive,
            terminalRef: { current: terminal },
            termRef: { current: container },
          }),
        { initialProps: { isActive: true } },
      );
      act(() => {
        result.current.toggleTextSelectionMode();
        result.current.handleSelectionPointerDown(pointerEvent());
      });

      rerender({ isActive: false });

      expect(result.current.isTextSelectionMode).toBe(false);
      expect(result.current.hasTerminalSelection).toBe(false);
      expect(result.current.copyStatus).toBe("idle");
    } finally {
      requestFrame.mockRestore();
    }
  });
});
