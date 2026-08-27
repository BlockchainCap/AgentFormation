"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TerminalPaneView } from "./terminal-pane-view";
import { getFollowUpConnectMode } from "./terminal-connection-state";
import { useTerminalPaneEffects } from "./use-terminal-pane-effects";
import { useTerminalTextSelection } from "./use-terminal-text-selection";
import { useTerminalUpload } from "./use-terminal-upload";
import {
  getAttachmentSubmitSuffix,
  readSessionResponse,
  terminateSession,
  type SessionInfo,
} from "./terminal-api";
import {
  type TerminalPaneProps,
  ConnectionState,
  ConnectMode,
  SESSION_REQUEST_TIMEOUT_MS,
  XTERM_SCROLLBACK_LINES,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_FONT_FAMILY,
  TERMINAL_SCROLL_LINE_PX,
  TERMINAL_SCROLL_OPTIONS,
  TERMINAL_VERTICAL_PADDING_PX,
  TERMINAL_MIN_COLUMNS,
  TERMINAL_MIN_ROWS,
  CLEAR_TERMINAL_INPUT,
  DpadPosition,
  terminalLinkHandler,
  getTerminalTheme,
  buildInputEditSequence,
  isSubmitShortcut,
  getDefaultDpadPosition,
  clampDpadPosition,
  isTerminalAtBottom,
  getTerminalColumnsForWidth,
  getDominantScrollAxis,
  getWheelScrollPixels,
  createWrappedUrlLinkProvider,
} from "./terminal-shared";

const MAX_PAUSED_OUTPUT_CHARACTERS = 1_000_000;
type TransportResetMode = "fresh" | "resume" | "background" | "unmount";

export function TerminalPane({ tmuxSession, isActive }: TerminalPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const sessionRef = useRef<SessionInfo | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const connectionIdRef = useRef(0);
  const connectionStartedAtRef = useRef(0);
  const connectInFlightRef = useRef(false);
  const submitInFlightRef = useRef(false);
  const queuedConnectModeRef = useRef<ConnectMode | null>(null);
  const connectRef = useRef<(mode?: ConnectMode) => Promise<void>>(
    async () => undefined,
  );
  const lastTermSizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const resizeTimeoutsRef = useRef<number[]>([]);
  const terminalFitFrameRef = useRef<number | null>(null);
  const terminalScrollFrameRef = useRef<number | null>(null);
  const terminalScrollTimeoutRef = useRef<number | null>(null);
  const stateRef = useRef<ConnectionState>("idle");
  const isReviewingHistoryRef = useRef(false);
  const pendingTerminalOutputRef = useRef<string[]>([]);
  const pendingTerminalOutputSizeRef = useRef(0);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [isSubmittingInput, setIsSubmittingInput] = useState(false);
  const [isReviewingHistory, setIsReviewingHistory] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState<number | null>(null);
  const [dpadPosition, setDpadPosition] = useState<DpadPosition | null>(null);
  const isConnected = state === "connected";
  const inputRef = useRef<HTMLInputElement>(null);
  const {
    handleFileSelection,
    pendingAttachments,
    removePendingAttachment,
    resetUploadState,
    setPendingAttachments,
    uploadError,
    uploadInFlightRef,
    uploadStatus,
  } = useTerminalUpload({ inputRef, tmuxSession });
  const dpadDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: DpadPosition;
    dragged: boolean;
  } | null>(null);
  const {
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
  } = useTerminalTextSelection({ isActive, terminalRef, termRef });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const resetTransport = useCallback(
    (mode: TransportResetMode) => {
      connectionIdRef.current += 1;
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      resizeTimeoutsRef.current.forEach(window.clearTimeout);
      resizeTimeoutsRef.current = [];
      if (terminalFitFrameRef.current !== null) {
        cancelAnimationFrame(terminalFitFrameRef.current);
        terminalFitFrameRef.current = null;
      }
      if (terminalScrollFrameRef.current !== null) {
        cancelAnimationFrame(terminalScrollFrameRef.current);
        terminalScrollFrameRef.current = null;
      }
      if (terminalScrollTimeoutRef.current !== null) {
        window.clearTimeout(terminalScrollTimeoutRef.current);
        terminalScrollTimeoutRef.current = null;
      }
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      queuedConnectModeRef.current = null;
      isReviewingHistoryRef.current = false;
      pendingTerminalOutputRef.current = [];
      pendingTerminalOutputSizeRef.current = 0;
      setIsReviewingHistory(false);
      resetUploadState();
      resetTextSelection();

      const activeSession = sessionRef.current;
      if (socketRef.current) {
        try {
          socketRef.current.close();
        } catch {
          /* noop */
        }
        socketRef.current = null;
      }
      if (terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
      fitAddonRef.current = null;
      seqRef.current = 0;
      lastTermSizeRef.current = null;
      stateRef.current = "idle";
      if (mode !== "unmount") setState("idle");

      if (mode !== "resume") {
        sessionRef.current = null;
      }

      if (
        (mode === "fresh" || mode === "unmount") &&
        activeSession?.sessionId &&
        activeSession.terminateToken
      ) {
        terminateSession(activeSession.sessionId, activeSession.terminateToken);
      }
    },
    [resetTextSelection, resetUploadState],
  );

  const getTermOptions = useCallback(() => {
    const terminal = terminalRef.current;
    return {
      rows: Math.max(TERMINAL_MIN_ROWS, terminal?.rows ?? 24),
      cols: Math.max(TERMINAL_MIN_COLUMNS, terminal?.cols ?? 80),
    };
  }, []);

  const fitTerminal = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    const container = termRef.current;
    if (
      !fitAddon ||
      !terminal ||
      !container?.clientWidth ||
      !container.clientHeight
    ) {
      return getTermOptions();
    }

    if (isTextSelectionModeRef.current) {
      return getTermOptions();
    }

    try {
      const wasAtBottom = isTerminalAtBottom(terminal);
      const dimensions = fitAddon.proposeDimensions();
      const rows = Math.max(
        TERMINAL_MIN_ROWS,
        dimensions?.rows ??
          Math.floor(container.clientHeight / TERMINAL_SCROLL_LINE_PX),
      );
      terminal.resize(
        Math.max(TERMINAL_MIN_COLUMNS, getTerminalColumnsForWidth(container)),
        rows,
      );
      if (wasAtBottom && !isReviewingHistoryRef.current) {
        terminal.scrollToBottom();
      }
    } catch {
      return getTermOptions();
    }

    return getTermOptions();
  }, [getTermOptions, isTextSelectionModeRef]);

  const updateTerminalReviewState = useCallback(() => {
    const nextIsReviewing = !isTerminalAtBottom(terminalRef.current);
    if (isReviewingHistoryRef.current !== nextIsReviewing) {
      isReviewingHistoryRef.current = nextIsReviewing;
      setIsReviewingHistory(nextIsReviewing);
    }

    return nextIsReviewing;
  }, []);

  const flushPendingTerminalOutput = useCallback(() => {
    const terminal = terminalRef.current;
    const output = pendingTerminalOutputRef.current.join("");
    pendingTerminalOutputRef.current = [];
    pendingTerminalOutputSizeRef.current = 0;
    if (!terminal || !output) return;

    const shouldFollowOutput = isTerminalAtBottom(terminal);
    terminal.write(output, () => {
      if (terminalRef.current !== terminal) return;
      if (shouldFollowOutput && !isReviewingHistoryRef.current) {
        terminal.scrollToBottom();
      }
      updateTerminalReviewState();
    });
  }, [updateTerminalReviewState]);

  useEffect(() => {
    if (!isTextSelectionMode) {
      flushPendingTerminalOutput();
    }
  }, [flushPendingTerminalOutput, isTextSelectionMode]);

  const scrollToTerminalBottom = useCallback(
    (options?: { force?: boolean; resetHorizontal?: boolean }) => {
      if (!options?.force && isReviewingHistoryRef.current) return;

      terminalRef.current?.scrollToBottom();
      if (options?.resetHorizontal) {
        scrollRef.current?.scrollTo({ left: 0 });
      }
      isReviewingHistoryRef.current = false;
      setIsReviewingHistory(false);
    },
    [],
  );

  const syncTerminalSize = useCallback(
    async (options?: { force?: boolean }) => {
      const socket = socketRef.current;
      const connectionId = connectionIdRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      const termOptions = fitTerminal();
      const lastTermSize = lastTermSizeRef.current;
      if (
        !options?.force &&
        lastTermSize?.rows === termOptions.rows &&
        lastTermSize?.cols === termOptions.cols
      ) {
        return;
      }

      lastTermSizeRef.current = termOptions;
      const { ssm } = await import("ssm-session");
      if (
        connectionId !== connectionIdRef.current ||
        socketRef.current !== socket ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      ssm.sendInitMessage(socket, termOptions);
    },
    [fitTerminal],
  );

  const scheduleTerminalSizeSync = useCallback(
    (options?: { force?: boolean }) => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
      }

      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        void syncTerminalSize(options);
      });
    },
    [syncTerminalSize],
  );

  const scheduleTerminalSizeBurst = useCallback(() => {
    resizeTimeoutsRef.current.forEach(window.clearTimeout);
    resizeTimeoutsRef.current = [];

    for (const delay of [0, 150, 500]) {
      const timeoutId = window.setTimeout(() => {
        scheduleTerminalSizeSync();
      }, delay);
      resizeTimeoutsRef.current.push(timeoutId);
    }
  }, [scheduleTerminalSizeSync]);

  const getRequestedTermOptions = useCallback(() => {
    const container = termRef.current;
    const scrollContainer = scrollRef.current;
    const height = scrollContainer?.clientHeight
      ? scrollContainer.clientHeight - TERMINAL_VERTICAL_PADDING_PX
      : 24 * TERMINAL_SCROLL_LINE_PX;

    return {
      rows: Math.max(
        TERMINAL_MIN_ROWS,
        Math.floor(height / TERMINAL_SCROLL_LINE_PX),
      ),
      cols: Math.max(
        TERMINAL_MIN_COLUMNS,
        container ? getTerminalColumnsForWidth(container) : 80,
      ),
    };
  }, []);

  const connect = useCallback(
    async (mode: ConnectMode = "start") => {
      if (connectInFlightRef.current) {
        queuedConnectModeRef.current = mode;
        return;
      }
      connectInFlightRef.current = true;
      let fallbackToFreshSession = false;
      const previousSession = sessionRef.current;
      const shouldResume = mode === "resume" && previousSession !== null;

      resetTransport(shouldResume ? "resume" : "fresh");

      const connectionId = connectionIdRef.current;
      const requestController = new AbortController();
      let didTimeout = false;
      requestAbortRef.current = requestController;
      connectionStartedAtRef.current = Date.now();

      stateRef.current = shouldResume ? "resuming" : "connecting";
      setState(stateRef.current);
      setError("");

      try {
        const timeoutId = window.setTimeout(() => {
          didTimeout = true;
          requestController.abort();
        }, SESSION_REQUEST_TIMEOUT_MS);

        const res = await fetch(
          shouldResume ? "/api/session/resume" : "/api/session/start",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: shouldResume
              ? JSON.stringify({
                  sessionId: previousSession!.sessionId,
                  terminateToken: previousSession!.terminateToken,
                })
              : JSON.stringify({
                  tmuxSession,
                  termOptions: getRequestedTermOptions(),
                }),
            credentials: "same-origin",
            signal: requestController.signal,
          },
        ).finally(() => window.clearTimeout(timeoutId));

        const info = await readSessionResponse(res);
        if (connectionId !== connectionIdRef.current) {
          terminateSession(info.sessionId, info.terminateToken);
          return;
        }

        sessionRef.current = info;

        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        if (connectionId !== connectionIdRef.current) return;

        const isDark = document.documentElement.classList.contains("dark");

        const terminal = new Terminal({
          cursorBlink: true,
          cols: 80,
          fontSize: TERMINAL_FONT_SIZE,
          lineHeight: TERMINAL_LINE_HEIGHT,
          fontFamily: TERMINAL_FONT_FAMILY,
          theme: getTerminalTheme(isDark),
          allowProposedApi: true,
          scrollback: XTERM_SCROLLBACK_LINES,
          ...TERMINAL_SCROLL_OPTIONS,
          convertEol: false,
          macOptionClickForcesSelection: true,
          linkHandler: terminalLinkHandler,
        });
        terminal.attachCustomWheelEventHandler((event) => {
          const scrollContainer = scrollRef.current;
          if (!scrollContainer) return true;

          const axis = getDominantScrollAxis(
            event.deltaX || (event.shiftKey ? event.deltaY : 0),
            event.shiftKey ? 0 : event.deltaY,
          );
          if (axis !== "horizontal") return true;

          const horizontalDelta = getWheelScrollPixels(event, scrollContainer);
          if (horizontalDelta === 0) return true;

          event.preventDefault();
          scrollContainer.scrollLeft += horizontalDelta;
          return false;
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.registerLinkProvider(createWrappedUrlLinkProvider(terminal));
        terminal.onScroll(() => {
          if (connectionId === connectionIdRef.current) {
            updateTerminalReviewState();
          }
        });
        terminal.onSelectionChange(() => {
          if (connectionId === connectionIdRef.current) {
            syncTerminalSelection(terminal);
          }
        });
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        if (termRef.current) {
          termRef.current.innerHTML = "";
          terminal.open(termRef.current);
          lastTermSizeRef.current = fitTerminal();
          terminalFitFrameRef.current = requestAnimationFrame(() => {
            terminalFitFrameRef.current = null;
            if (connectionId !== connectionIdRef.current) return;
            lastTermSizeRef.current = fitTerminal();
          });
        }

        const { ssm } = await import("ssm-session");
        if (connectionId !== connectionIdRef.current) return;

        const textEncoder = new TextEncoder();
        const textDecoder = new TextDecoder();

        const socket = new WebSocket(info.streamUrl);
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (connectionId !== connectionIdRef.current) return;

          const termOptions = fitTerminal();
          lastTermSizeRef.current = termOptions;
          seqRef.current = 0;
          ssm.init(socket, { token: info.tokenValue, termOptions });
          scheduleTerminalSizeBurst();
        });

        socket.addEventListener("message", (event) => {
          if (connectionId !== connectionIdRef.current) return;

          let agentMessage: ReturnType<typeof ssm.decode>;
          try {
            agentMessage = ssm.decode(event.data);
            ssm.sendACK(socket, agentMessage);
          } catch {
            socket.close();
            stateRef.current = "error";
            setState("error");
            setError("The terminal received an invalid session message.");
            return;
          }

          if (agentMessage.payloadType === 1) {
            const text = textDecoder.decode(agentMessage.payload, {
              stream: true,
            });
            if (text) {
              const outputText = text;
              const shouldFollowOutput = isTerminalAtBottom(terminal);
              if (!outputText) {
                terminal.scrollToBottom();
                updateTerminalReviewState();
                stateRef.current = "connected";
                setState("connected");
                return;
              }
              if (
                isTextSelectionModeRef.current ||
                pendingTerminalOutputRef.current.length > 0
              ) {
                pendingTerminalOutputRef.current.push(outputText);
                pendingTerminalOutputSizeRef.current += outputText.length;
                if (
                  !isTextSelectionModeRef.current ||
                  pendingTerminalOutputSizeRef.current >=
                    MAX_PAUSED_OUTPUT_CHARACTERS
                ) {
                  flushPendingTerminalOutput();
                }
                stateRef.current = "connected";
                setState("connected");
                return;
              }
              terminal.write(outputText, () => {
                if (
                  connectionId !== connectionIdRef.current ||
                  terminalRef.current !== terminal
                ) {
                  return;
                }
                if (shouldFollowOutput && !isReviewingHistoryRef.current) {
                  terminal.scrollToBottom();
                }
                updateTerminalReviewState();
              });
            }
            stateRef.current = "connected";
            setState("connected");
          } else if (agentMessage.payloadType === 17) {
            const termOptions = fitTerminal();
            lastTermSizeRef.current = termOptions;
            ssm.sendInitMessage(socket, termOptions);
            stateRef.current = "connected";
            setState("connected");
            scheduleTerminalSizeBurst();
            if (terminalScrollFrameRef.current !== null) {
              cancelAnimationFrame(terminalScrollFrameRef.current);
            }
            if (terminalScrollTimeoutRef.current !== null) {
              window.clearTimeout(terminalScrollTimeoutRef.current);
            }
            terminalScrollFrameRef.current = requestAnimationFrame(() => {
              terminalScrollFrameRef.current = null;
              if (connectionId !== connectionIdRef.current) return;
              scrollToTerminalBottom({ force: true });
            });
            terminalScrollTimeoutRef.current = window.setTimeout(() => {
              terminalScrollTimeoutRef.current = null;
              if (connectionId !== connectionIdRef.current) return;
              scrollToTerminalBottom({ force: true });
            }, 120);
          }
        });

        socket.addEventListener("close", () => {
          if (
            connectionId !== connectionIdRef.current ||
            socketRef.current !== socket
          ) {
            return;
          }

          socketRef.current = null;
          const trailingText = textDecoder.decode();
          if (trailingText && terminalRef.current === terminal) {
            if (
              isTextSelectionModeRef.current ||
              pendingTerminalOutputRef.current.length > 0
            ) {
              pendingTerminalOutputRef.current.push(trailingText);
              pendingTerminalOutputSizeRef.current += trailingText.length;
              if (!isTextSelectionModeRef.current) {
                flushPendingTerminalOutput();
              }
            } else {
              terminal.write(trailingText);
            }
          }
          stateRef.current = "error";
          setState("error");
          setError("Session ended. Reconnect to attach to this tmux tab.");
        });
        socket.addEventListener("error", () => {
          if (
            connectionId !== connectionIdRef.current ||
            socketRef.current !== socket
          ) {
            return;
          }

          stateRef.current = "error";
          setState("error");
          setError(
            "WebSocket connection lost. Reconnect to attach to this tmux tab.",
          );
        });

        terminal.onData((data) => {
          if (connectionId !== connectionIdRef.current) return;
          if (socket.readyState === WebSocket.OPEN) {
            ssm.sendText(socket, textEncoder.encode(data), seqRef.current++);
          }
        });
      } catch (err) {
        if (
          connectionId !== connectionIdRef.current ||
          (requestController.signal.aborted && !didTimeout)
        ) {
          return;
        }

        if (shouldResume) {
          sessionRef.current = null;
          if (previousSession) {
            terminateSession(
              previousSession.sessionId,
              previousSession.terminateToken,
            );
          }
          fallbackToFreshSession = true;
        } else {
          stateRef.current = "error";
          setState("error");
          setError(
            didTimeout
              ? "Terminal session request timed out. Try reconnecting."
              : err instanceof Error
                ? err.message
                : "Connection failed",
          );
        }
      } finally {
        if (requestAbortRef.current === requestController) {
          requestAbortRef.current = null;
        }
        connectInFlightRef.current = false;
        const queuedMode = getFollowUpConnectMode({
          connectionId,
          currentConnectionId: connectionIdRef.current,
          fallbackToFreshSession,
          queuedConnectMode: queuedConnectModeRef.current,
        });
        queuedConnectModeRef.current = null;
        if (queuedMode) {
          void connectRef.current(queuedMode);
        }
      }
    },
    [
      fitTerminal,
      flushPendingTerminalOutput,
      getRequestedTermOptions,
      isTextSelectionModeRef,
      resetTransport,
      scheduleTerminalSizeBurst,
      scrollToTerminalBottom,
      syncTerminalSelection,
      tmuxSession,
      updateTerminalReviewState,
    ],
  );

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const sendInput = useCallback(async (text: string): Promise<boolean> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const { ssm } = await import("ssm-session");
    if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const encoder = new TextEncoder();
    ssm.sendText(socket, encoder.encode(text), seqRef.current++);
    return true;
  }, []);

  const lastValueRef = useRef("");

  const clearTerminalInput = useCallback(() => {
    lastValueRef.current = "";
    setInputValue("");
    void sendInput(CLEAR_TERMINAL_INPUT);
  }, [sendInput]);

  const handleQuickKeyActivate = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();

      if (event.currentTarget.dataset.action === "clear") {
        clearTerminalInput();
        return;
      }

      const seq = event.currentTarget.dataset.seq;
      if (seq) {
        void sendInput(seq);
      }
    },
    [clearTerminalInput, sendInput],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = e.target.value;
      const prev = lastValueRef.current;
      const nextCursorIndex = e.target.selectionStart ?? next.length;
      const editSequence = buildInputEditSequence(prev, next, nextCursorIndex);

      if (editSequence) sendInput(editSequence);

      lastValueRef.current = next;
      setInputValue(next);
    },
    [sendInput],
  );

  const handleSubmit = useCallback(async () => {
    if (submitInFlightRef.current || uploadInFlightRef.current) return;
    submitInFlightRef.current = true;
    setIsSubmittingInput(true);
    try {
      const attachmentSuffix = getAttachmentSubmitSuffix(
        lastValueRef.current,
        pendingAttachments,
      );
      const sent = await sendInput(`${attachmentSuffix}\r`);
      if (sent) {
        setInputValue("");
        lastValueRef.current = "";
        setPendingAttachments([]);
      } else {
        setError("Terminal connection was lost. Reconnect and submit again.");
      }
    } catch {
      setError("Terminal input could not be sent. Reconnect and submit again.");
    } finally {
      submitInFlightRef.current = false;
      setIsSubmittingInput(false);
    }
  }, [pendingAttachments, sendInput, setPendingAttachments, uploadInFlightRef]);

  const handleDpadPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dpadDragRef.current) return;
      const position = dpadPosition ?? getDefaultDpadPosition();
      dpadDragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origin: position,
        dragged: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    [dpadPosition],
  );

  const handleDpadPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dpadDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;

      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.dragged && Math.hypot(dx, dy) < 5) return;

      drag.dragged = true;
      setDpadPosition(
        clampDpadPosition({
          x: drag.origin.x + dx,
          y: drag.origin.y + dy,
        }),
      );
    },
    [],
  );

  const handleDpadPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dpadDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;

      dpadDragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    [],
  );

  const handleDpadPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dpadDragRef.current?.pointerId === e.pointerId) {
        dpadDragRef.current = null;
      }
    },
    [],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (isSubmitShortcut(e)) {
          void handleSubmit();
          return;
        }

        inputRef.current?.blur();
      }
    },
    [handleSubmit],
  );

  const handleDpadButtonActivate = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      const seq = e.currentTarget.dataset.seq;
      if (!seq) return;

      e.preventDefault();
      e.stopPropagation();
      sendInput(seq);
    },
    [sendInput],
  );

  const reconnect = useCallback(() => {
    void connect("start");
  }, [connect]);

  const reconnectIfNeeded = useCallback(() => {
    const socket = socketRef.current;
    if (
      stateRef.current === "connected" &&
      socket?.readyState === WebSocket.OPEN
    ) {
      scheduleTerminalSizeBurst();
      return;
    }

    const isConnecting =
      stateRef.current === "connecting" || stateRef.current === "resuming";
    const requestAgeMs = Date.now() - connectionStartedAtRef.current;
    if (isConnecting && requestAgeMs < SESSION_REQUEST_TIMEOUT_MS) {
      return;
    }

    if (connectInFlightRef.current) {
      queuedConnectModeRef.current = sessionRef.current ? "resume" : "start";
      requestAbortRef.current?.abort();
      return;
    }
    void connect(sessionRef.current ? "resume" : "start");
  }, [connect, scheduleTerminalSizeBurst]);

  useTerminalPaneEffects({
    connect,
    dpadPosition,
    isActive,
    reconnectIfNeeded,
    resetTransport,
    scheduleTerminalSizeBurst,
    scrollRef,
    sessionRef,
    setDpadPosition,
    setTerminalHeight,
    state,
    termRef,
    terminalRef,
    updateTerminalReviewState,
  });

  return (
    <TerminalPaneView
      dpadPosition={dpadPosition}
      error={error}
      fileInputRef={fileInputRef}
      handleChange={handleChange}
      handleDpadButtonActivate={handleDpadButtonActivate}
      handleDpadPointerCancel={handleDpadPointerCancel}
      handleDpadPointerDown={handleDpadPointerDown}
      handleDpadPointerMove={handleDpadPointerMove}
      handleDpadPointerUp={handleDpadPointerUp}
      handleFileSelection={handleFileSelection}
      handleKeyDown={handleKeyDown}
      handleQuickKeyActivate={handleQuickKeyActivate}
      handleSelectionPointerCancel={handleSelectionPointerCancel}
      handleSelectionPointerDown={handleSelectionPointerDown}
      handleSelectionPointerMove={handleSelectionPointerMove}
      handleSelectionPointerUp={handleSelectionPointerUp}
      handleSubmit={handleSubmit}
      hasTerminalSelection={hasTerminalSelection}
      inputRef={inputRef}
      inputValue={inputValue}
      isActive={isActive}
      isConnected={isConnected}
      isSubmittingInput={isSubmittingInput}
      isReviewingHistory={isReviewingHistory}
      isTextSelectionMode={isTextSelectionMode}
      pendingAttachments={pendingAttachments}
      copyStatus={copyStatus}
      copyTerminalSelection={copyTerminalSelection}
      reconnect={reconnect}
      removePendingAttachment={removePendingAttachment}
      scrollRef={scrollRef}
      scrollToTerminalBottom={scrollToTerminalBottom}
      state={state}
      terminalHeight={terminalHeight}
      termRef={termRef}
      toggleTextSelectionMode={toggleTextSelectionMode}
      uploadError={uploadError}
      uploadStatus={uploadStatus}
    />
  );
}
