"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { Terminal } from "@xterm/xterm";
import {
  getTerminalBufferPoint,
  getTerminalSelectionRange,
  type TerminalBufferPoint,
} from "./terminal-shared";

interface UseTerminalTextSelectionOptions {
  isActive: boolean;
  terminalRef: RefObject<Terminal | null>;
  termRef: RefObject<HTMLDivElement | null>;
}

export type TerminalCopyStatus = "idle" | "copied" | "error";
export const MAX_TERMINAL_SELECTION_CHARACTERS = 1_000_000;

function hasTerminalSelectionSurfaceFocus(): boolean {
  return (
    document.activeElement instanceof HTMLElement &&
    document.activeElement.classList.contains("terminal-selection-surface")
  );
}

export function useTerminalTextSelection({
  isActive,
  terminalRef,
  termRef,
}: UseTerminalTextSelectionOptions) {
  const [isTextSelectionMode, setIsTextSelectionMode] = useState(false);
  const [hasTerminalSelection, setHasTerminalSelection] = useState(false);
  const [copyStatus, setCopyStatus] = useState<TerminalCopyStatus>("idle");
  const isTextSelectionModeRef = useRef(false);
  const selectedTextRef = useRef("");
  const copyRequestIdRef = useRef(0);
  const dragRef = useRef<{
    pointerId: number;
    anchor: TerminalBufferPoint;
  } | null>(null);

  const setTextSelectionMode = useCallback((enabled: boolean) => {
    isTextSelectionModeRef.current = enabled;
    setIsTextSelectionMode(enabled);
  }, []);

  const captureTerminalSelection = useCallback(
    (terminal: Terminal, clearWhenEmpty: boolean) => {
      const selection = terminal.getSelection();
      if (selection) {
        selectedTextRef.current = selection.slice(
          0,
          MAX_TERMINAL_SELECTION_CHARACTERS,
        );
        setHasTerminalSelection(true);
        return;
      }
      if (clearWhenEmpty) {
        selectedTextRef.current = "";
        setHasTerminalSelection(false);
      }
    },
    [],
  );

  const resetTextSelection = useCallback(() => {
    copyRequestIdRef.current += 1;
    dragRef.current = null;
    selectedTextRef.current = "";
    isTextSelectionModeRef.current = false;
    terminalRef.current?.clearSelection();
    setIsTextSelectionMode(false);
    setHasTerminalSelection(false);
    setCopyStatus("idle");
  }, [terminalRef]);

  const syncTerminalSelection = useCallback(
    (terminal: Terminal) => {
      // Active TUIs repaint often. xterm clears its visual selection on a write,
      // but the text the person selected must remain copyable until they leave
      // selection mode.
      captureTerminalSelection(terminal, !isTextSelectionModeRef.current);
    },
    [captureTerminalSelection],
  );

  const toggleTextSelectionMode = useCallback(() => {
    copyRequestIdRef.current += 1;
    terminalRef.current?.clearSelection();
    setHasTerminalSelection(false);
    setCopyStatus("idle");
    dragRef.current = null;
    selectedTextRef.current = "";
    setTextSelectionMode(!isTextSelectionModeRef.current);
  }, [setTextSelectionMode, terminalRef]);

  const updateTextSelection = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const terminal = terminalRef.current;
      const container = termRef.current;
      if (
        !drag ||
        drag.pointerId !== event.pointerId ||
        !terminal ||
        !container
      )
        return;

      const focus = getTerminalBufferPoint(
        terminal,
        container,
        event.clientX,
        event.clientY,
        true,
      );
      if (!focus) return;

      const range = getTerminalSelectionRange(
        drag.anchor,
        focus,
        terminal.cols,
      );
      terminal.select(
        range.column,
        range.row,
        Math.min(range.length, MAX_TERMINAL_SELECTION_CHARACTERS),
      );
      captureTerminalSelection(terminal, true);
      setCopyStatus("idle");
    },
    [captureTerminalSelection, termRef, terminalRef],
  );

  const handleSelectionPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (dragRef.current) return;

      const terminal = terminalRef.current;
      const container = termRef.current;
      if (!terminal || !container) return;

      const anchor = getTerminalBufferPoint(
        terminal,
        container,
        event.clientX,
        event.clientY,
        true,
      );
      if (!anchor) return;

      // A new drag starts a new selection. Drop any text preserved from the
      // previous drag before xterm has a chance to report the new range.
      copyRequestIdRef.current += 1;
      selectedTextRef.current = "";
      setHasTerminalSelection(false);
      terminal.clearSelection();
      dragRef.current = { pointerId: event.pointerId, anchor };
      event.currentTarget.focus({ preventScroll: true });
      terminal.select(anchor.column, anchor.row, 1);
      captureTerminalSelection(terminal, true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [captureTerminalSelection, termRef, terminalRef],
  );

  const handleSelectionPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      updateTextSelection(event);
      if (dragRef.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [updateTextSelection],
  );

  const handleSelectionPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;

      updateTextSelection(event);
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [updateTextSelection],
  );

  const handleSelectionPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current?.pointerId === event.pointerId) {
        dragRef.current = null;
      }
    },
    [],
  );

  const finishCopy = useCallback(() => {
    copyRequestIdRef.current += 1;
    dragRef.current = null;
    selectedTextRef.current = "";
    terminalRef.current?.clearSelection();
    setHasTerminalSelection(false);
    setCopyStatus("copied");
    setTextSelectionMode(false);
  }, [setTextSelectionMode, terminalRef]);

  const copyTerminalSelection = useCallback(() => {
    const selection = (
      selectedTextRef.current ||
      terminalRef.current?.getSelection() ||
      ""
    ).slice(0, MAX_TERMINAL_SELECTION_CHARACTERS);
    if (!selection) return;
    const requestId = copyRequestIdRef.current + 1;
    copyRequestIdRef.current = requestId;

    if (!navigator.clipboard) {
      setCopyStatus("error");
      return;
    }

    void navigator.clipboard.writeText(selection).then(
      () => {
        if (copyRequestIdRef.current === requestId) finishCopy();
      },
      () => {
        if (copyRequestIdRef.current === requestId) setCopyStatus("error");
      },
    );
  }, [finishCopy, terminalRef]);

  useEffect(() => {
    if (!isActive || !isTextSelectionMode) return;

    const handleCopy = (event: ClipboardEvent) => {
      if (!hasTerminalSelectionSurfaceFocus()) return;
      const selection = selectedTextRef.current;
      if (!selection || !event.clipboardData) return;

      event.clipboardData.setData("text/plain", selection);
      event.preventDefault();
      event.stopPropagation();
      finishCopy();
    };

    const handleCopyShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "c" ||
        (!event.metaKey && !event.ctrlKey) ||
        !selectedTextRef.current ||
        !hasTerminalSelectionSurfaceFocus()
      ) {
        return;
      }

      // Stop xterm from treating Ctrl+C as terminal input. This keydown is a
      // browser user gesture, so it can use the same verified Clipboard API
      // path as the visible Copy button.
      event.preventDefault();
      event.stopPropagation();
      copyTerminalSelection();
    };

    document.addEventListener("copy", handleCopy, true);
    document.addEventListener("keydown", handleCopyShortcut, true);
    return () => {
      document.removeEventListener("copy", handleCopy, true);
      document.removeEventListener("keydown", handleCopyShortcut, true);
    };
  }, [copyTerminalSelection, finishCopy, isActive, isTextSelectionMode]);

  useEffect(() => {
    if (isActive) return;
    const frame = requestAnimationFrame(resetTextSelection);
    return () => cancelAnimationFrame(frame);
  }, [isActive, resetTextSelection]);

  return {
    copyStatus,
    copyTerminalSelection,
    handleSelectionPointerCancel,
    handleSelectionPointerDown,
    handleSelectionPointerMove,
    handleSelectionPointerUp,
    hasTerminalSelection,
    isTextSelectionMode,
    isTextSelectionModeRef,
    resetTextSelection,
    syncTerminalSelection,
    toggleTextSelectionMode,
  };
}
