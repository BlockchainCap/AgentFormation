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
  const isTextSelectionModeRef = useRef(false);
  const selectedTextRef = useRef("");
  const dragRef = useRef<{
    pointerId: number;
    anchor: TerminalBufferPoint;
  } | null>(null);

  const setTextSelectionMode = useCallback((enabled: boolean) => {
    isTextSelectionModeRef.current = enabled;
    setIsTextSelectionMode(enabled);
  }, []);

  const preserveTerminalSelection = useCallback((terminal: Terminal) => {
    const selection = terminal.getSelection();
    if (!selection) return;

    selectedTextRef.current = selection;
    setHasTerminalSelection(true);
  }, []);

  const resetTextSelection = useCallback(() => {
    dragRef.current = null;
    selectedTextRef.current = "";
    isTextSelectionModeRef.current = false;
    terminalRef.current?.clearSelection();
    setIsTextSelectionMode(false);
    setHasTerminalSelection(false);
    setCopyStatus("idle");
  }, [terminalRef]);

  const syncTerminalSelection = useCallback((terminal: Terminal) => {
    const selection = terminal.getSelection();
    if (selection) {
      selectedTextRef.current = selection;
      setHasTerminalSelection(true);
      return;
    }

    // Active TUIs repaint often. xterm clears its visual selection on a write,
    // but the text the person selected must remain copyable until they leave
    // selection mode.
    if (!isTextSelectionModeRef.current) {
      selectedTextRef.current = "";
      setHasTerminalSelection(false);
    }
  }, []);

  const toggleTextSelectionMode = useCallback(() => {
    terminalRef.current?.clearSelection();
    setHasTerminalSelection(false);
    setCopyStatus("idle");
    dragRef.current = null;
    selectedTextRef.current = "";
    setIsTextSelectionMode((current) => {
      const next = !current;
      isTextSelectionModeRef.current = next;
      return next;
    });
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
      preserveTerminalSelection(terminal);
      setCopyStatus("idle");
    },
    [preserveTerminalSelection, termRef, terminalRef],
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
      preserveTerminalSelection(terminal);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [preserveTerminalSelection, termRef, terminalRef],
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
    dragRef.current = null;
    setCopyStatus("copied");
    setTextSelectionMode(false);
  }, [setTextSelectionMode]);

  const copyTerminalSelection = useCallback(() => {
    const selection =
      selectedTextRef.current || terminalRef.current?.getSelection() || "";
    if (!selection) return;

    if (
      typeof document.execCommand === "function" &&
      document.execCommand("copy")
    ) {
      return;
    }

    if (!navigator.clipboard) {
      setCopyStatus("error");
      return;
    }

    void navigator.clipboard
      .writeText(selection)
      .then(finishCopy, () => setCopyStatus("error"));
  }, [finishCopy, terminalRef]);

  useEffect(() => {
    if (!isTextSelectionMode) return;

    const handleCopy = (event: ClipboardEvent) => {
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
        !selectedTextRef.current
      ) {
        return;
      }

      // Stop xterm from treating Ctrl+C as terminal input. Leaving the browser's
      // default Copy action intact causes the synchronous `copy` event above,
      // which can populate the system clipboard without a permission prompt.
      event.stopPropagation();
    };

    document.addEventListener("copy", handleCopy, true);
    document.addEventListener("keydown", handleCopyShortcut, true);
    return () => {
      document.removeEventListener("copy", handleCopy, true);
      document.removeEventListener("keydown", handleCopyShortcut, true);
    };
  }, [copyTerminalSelection, finishCopy, isTextSelectionMode]);

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
