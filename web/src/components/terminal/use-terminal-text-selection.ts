"use client";

import {
  useCallback,
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
  terminalRef: RefObject<Terminal | null>;
  termRef: RefObject<HTMLDivElement | null>;
}

export type TerminalCopyStatus = "idle" | "copied" | "error";

export function useTerminalTextSelection({
  terminalRef,
  termRef,
}: UseTerminalTextSelectionOptions) {
  const [isTextSelectionMode, setIsTextSelectionMode] = useState(false);
  const [hasTerminalSelection, setHasTerminalSelection] = useState(false);
  const [copyStatus, setCopyStatus] = useState<TerminalCopyStatus>("idle");
  const dragRef = useRef<{
    pointerId: number;
    anchor: TerminalBufferPoint;
  } | null>(null);

  const resetTextSelection = useCallback(() => {
    dragRef.current = null;
    setIsTextSelectionMode(false);
    setHasTerminalSelection(false);
    setCopyStatus("idle");
  }, []);

  const syncTerminalSelection = useCallback((terminal: Terminal) => {
    setHasTerminalSelection(terminal.hasSelection());
  }, []);

  const toggleTextSelectionMode = useCallback(() => {
    terminalRef.current?.clearSelection();
    setHasTerminalSelection(false);
    setCopyStatus("idle");
    dragRef.current = null;
    setIsTextSelectionMode((current) => !current);
  }, [terminalRef]);

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
      terminal.select(range.column, range.row, range.length);
      setCopyStatus("idle");
    },
    [termRef, terminalRef],
  );

  const handleSelectionPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;

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

      dragRef.current = { pointerId: event.pointerId, anchor };
      terminal.select(anchor.column, anchor.row, 1);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [termRef, terminalRef],
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

  const copyTerminalSelection = useCallback(() => {
    const selection = terminalRef.current?.getSelection() ?? "";
    if (!selection) return;

    void navigator.clipboard.writeText(selection).then(
      () => {
        setCopyStatus("copied");
        setIsTextSelectionMode(false);
      },
      () => setCopyStatus("error"),
    );
  }, [terminalRef]);

  return {
    copyStatus,
    copyTerminalSelection,
    handleSelectionPointerCancel,
    handleSelectionPointerDown,
    handleSelectionPointerMove,
    handleSelectionPointerUp,
    hasTerminalSelection,
    isTextSelectionMode,
    resetTextSelection,
    syncTerminalSelection,
    toggleTextSelectionMode,
  };
}
