"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TerminalPaneView } from "./terminal-pane-view";
import { useTerminalPaneEffects } from "./use-terminal-pane-effects";
import { useTerminalTextSelection } from "./use-terminal-text-selection";
import {
  SessionInfo,
  TerminalPaneProps,
  UploadCreateResponse,
  UploadCompleteResponse,
  PendingAttachment,
  ConnectionState,
  ConnectMode,
  UploadStatus,
  SESSION_REQUEST_TIMEOUT_MS,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  XTERM_SCROLLBACK_LINES,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_FONT_FAMILY,
  TERMINAL_SCROLL_LINE_PX,
  TERMINAL_SCROLL_OPTIONS,
  TERMINAL_VERTICAL_PADDING_PX,
  CLEAR_TERMINAL_INPUT,
  DpadPosition,
  terminalLinkHandler,
  readJsonResponse,
  uploadFileToUrl,
  getAttachmentSubmitSuffix,
  getTerminalTheme,
  buildInputEditSequence,
  isSubmitShortcut,
  getDefaultDpadPosition,
  clampDpadPosition,
  terminateSession,
  readSessionResponse,
  isTerminalAtBottom,
  getTerminalColumnsForWidth,
  getDominantScrollAxis,
  getWheelScrollPixels,
  filterStartupProfileEchoes,
  containsStartupProfileEcho,
  normalizeBootstrapText,
  createWrappedUrlLinkProvider,
} from "./terminal-shared";

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
  const uploadInFlightRef = useRef(false);
  const connectionIdRef = useRef(0);
  const connectionStartedAtRef = useRef(0);
  const connectRef = useRef<(mode?: ConnectMode) => Promise<void>>(
    async () => undefined,
  );
  const lastTermSizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const resizeTimeoutsRef = useRef<number[]>([]);
  const stateRef = useRef<ConnectionState>("idle");
  const isReviewingHistoryRef = useRef(false);
  const startupInputClearSentRef = useRef(false);
  const pendingTerminalOutputRef = useRef<string[]>([]);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>({
    state: "idle",
  });
  const [uploadError, setUploadError] = useState("");
  const [isReviewingHistory, setIsReviewingHistory] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState<number | null>(null);
  const [dpadPosition, setDpadPosition] = useState<DpadPosition | null>(null);
  const isConnected = state === "connected";
  const inputRef = useRef<HTMLInputElement>(null);
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
  } = useTerminalTextSelection({ terminalRef, termRef });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const resetTransport = useCallback(
    (options?: {
      clearSession?: boolean;
      disposeTerminal?: boolean;
      terminateSession?: boolean;
    }) => {
      connectionIdRef.current += 1;
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      resizeTimeoutsRef.current.forEach(window.clearTimeout);
      resizeTimeoutsRef.current = [];
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      isReviewingHistoryRef.current = false;
      startupInputClearSentRef.current = false;
      pendingTerminalOutputRef.current = [];
      setIsReviewingHistory(false);
      setPendingAttachments([]);
      setUploadStatus({ state: "idle" });
      setUploadError("");
      resetTextSelection();

      const activeSession = sessionRef.current;
      const shouldDisposeTerminal = options?.disposeTerminal ?? true;

      if (socketRef.current) {
        try {
          socketRef.current.close();
        } catch {
          /* noop */
        }
        socketRef.current = null;
      }
      if (shouldDisposeTerminal && terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
      if (shouldDisposeTerminal) {
        fitAddonRef.current = null;
      }
      seqRef.current = 0;
      lastTermSizeRef.current = null;

      if (options?.clearSession ?? options?.terminateSession) {
        sessionRef.current = null;
      }

      if (
        options?.terminateSession &&
        activeSession?.sessionId &&
        activeSession.terminateToken
      ) {
        terminateSession(activeSession.sessionId, activeSession.terminateToken);
      }
    },
    [resetTextSelection],
  );

  const getTermOptions = useCallback(() => {
    const terminal = terminalRef.current;
    return {
      rows: terminal?.rows ?? 24,
      cols: terminal?.cols ?? 80,
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
        1,
        dimensions?.rows ??
          Math.floor(container.clientHeight / TERMINAL_SCROLL_LINE_PX),
      );
      terminal.resize(getTerminalColumnsForWidth(container), rows);
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
    if (!terminal || !output) return;

    const shouldFollowOutput = isTerminalAtBottom(terminal);
    terminal.write(output, () => {
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

    for (const delay of [0, 80, 200, 500, 900]) {
      const timeoutId = window.setTimeout(() => {
        scheduleTerminalSizeSync({ force: true });
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
      rows: Math.max(1, Math.floor(height / TERMINAL_SCROLL_LINE_PX)),
      cols: container ? getTerminalColumnsForWidth(container) : 80,
    };
  }, []);

  const connect = useCallback(
    async (mode: ConnectMode = "start") => {
      const previousSession = sessionRef.current;
      const shouldResume = mode === "resume" && previousSession !== null;

      resetTransport({
        clearSession: !shouldResume,
        disposeTerminal: true,
        terminateSession: mode === "start",
      });

      const connectionId = connectionIdRef.current;
      const requestController = new AbortController();
      let didTimeout = false;
      requestAbortRef.current = requestController;
      connectionStartedAtRef.current = Date.now();

      setState(shouldResume ? "resuming" : "connecting");
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

        if (connectionId !== connectionIdRef.current) return;

        const info = await readSessionResponse(res);
        if (connectionId !== connectionIdRef.current) return;

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
          if (!shouldResume && info.bootstrapText) {
            const bootstrapText = normalizeBootstrapText(info.bootstrapText);
            if (bootstrapText) {
              terminal.write(bootstrapText, () => {
                terminal.scrollToBottom();
                updateTerminalReviewState();
              });
            }
          }
          requestAnimationFrame(() => {
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

          const agentMessage = ssm.decode(event.data);
          ssm.sendACK(socket, agentMessage);

          if (agentMessage.payloadType === 1) {
            const text = textDecoder.decode(agentMessage.payload);
            if (text) {
              const isInitialOutput = stateRef.current !== "connected";
              if (
                isInitialOutput &&
                !startupInputClearSentRef.current &&
                containsStartupProfileEcho(text) &&
                socket.readyState === WebSocket.OPEN
              ) {
                startupInputClearSentRef.current = true;
                ssm.sendText(
                  socket,
                  textEncoder.encode(CLEAR_TERMINAL_INPUT),
                  seqRef.current++,
                );
              }
              const outputText = !isInitialOutput
                ? text
                : filterStartupProfileEchoes(text);
              const shouldFollowOutput = isTerminalAtBottom(terminal);
              if (!outputText) {
                terminal.scrollToBottom();
                updateTerminalReviewState();
                setState("connected");
                return;
              }
              if (isTextSelectionModeRef.current) {
                pendingTerminalOutputRef.current.push(outputText);
                setState("connected");
                return;
              }
              terminal.write(outputText, () => {
                if (shouldFollowOutput && !isReviewingHistoryRef.current) {
                  terminal.scrollToBottom();
                }
                updateTerminalReviewState();
              });
            }
            setState("connected");
          } else if (agentMessage.payloadType === 17) {
            const termOptions = fitTerminal();
            lastTermSizeRef.current = termOptions;
            ssm.sendInitMessage(socket, termOptions);
            setState("connected");
            scheduleTerminalSizeBurst();
            requestAnimationFrame(() =>
              scrollToTerminalBottom({ force: true }),
            );
            window.setTimeout(() => {
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
          void connectRef.current("start");
          return;
        }

        setState("error");
        setError(
          didTimeout
            ? "Terminal session request timed out. Try reconnecting."
            : err instanceof Error
              ? err.message
              : "Connection failed",
        );
      } finally {
        if (requestAbortRef.current === requestController) {
          requestAbortRef.current = null;
        }
      }
    },
    [
      fitTerminal,
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

  const sendInput = useCallback(async (text: string) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN)
      return;
    const { ssm } = await import("ssm-session");
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN)
      return;
    const encoder = new TextEncoder();
    ssm.sendText(socketRef.current!, encoder.encode(text), seqRef.current++);
  }, []);

  const lastValueRef = useRef("");

  const clearTerminalInput = useCallback(() => {
    lastValueRef.current = "";
    setInputValue("");
    void sendInput(CLEAR_TERMINAL_INPUT);
  }, [sendInput]);

  const handleQuickKeyPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
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

  const handleSubmit = useCallback(() => {
    const attachmentSuffix = getAttachmentSubmitSuffix(
      lastValueRef.current,
      pendingAttachments,
    );
    if (attachmentSuffix) {
      void sendInput(attachmentSuffix).then(() => {
        window.setTimeout(() => {
          void sendInput("\r");
        }, 50);
      });
    } else {
      void sendInput("\r");
    }
    setInputValue("");
    lastValueRef.current = "";
    setPendingAttachments([]);
  }, [pendingAttachments, sendInput]);

  const removePendingAttachment = useCallback((attachmentId: string) => {
    setPendingAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId),
    );
  }, []);

  const handleFileSelection = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || uploadInFlightRef.current) return;

      if (file.size < 1 || file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
        setUploadError("Files must be between 1 byte and 50 MB.");
        return;
      }

      uploadInFlightRef.current = true;
      setUploadError("");
      setUploadStatus({ state: "uploading", filename: file.name, progress: 0 });

      try {
        const mimeType = file.type || "application/octet-stream";
        const createResponse = await fetch("/api/session/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            mimeType,
            fileSize: file.size,
          }),
        });
        const upload =
          await readJsonResponse<UploadCreateResponse>(createResponse);

        await uploadFileToUrl(
          file,
          upload.uploadUrl,
          upload.requiredHeaders,
          (progress) => {
            setUploadStatus({
              state: "uploading",
              filename: file.name,
              progress,
            });
          },
        );

        setUploadStatus({ state: "completing", filename: file.name });
        const completeResponse = await fetch("/api/session/upload", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: upload.key,
            filename: upload.filename,
            mimeType: upload.mimeType,
            fileSize: upload.fileSize,
            tmuxSession,
          }),
        });
        const completed =
          await readJsonResponse<UploadCompleteResponse>(completeResponse);

        if (!completed.path) {
          throw new Error("Upload completed without a remote file path");
        }

        setPendingAttachments((current) => [
          ...current,
          {
            ...completed,
            id: completed.path,
          },
        ]);
        inputRef.current?.focus();
        setUploadStatus({ state: "idle" });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "File upload failed";
        setUploadError(message);
        setUploadStatus({ state: "idle" });
      } finally {
        uploadInFlightRef.current = false;
      }
    },
    [tmuxSession],
  );

  const handleDpadPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
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
          handleSubmit();
          return;
        }

        inputRef.current?.blur();
      }
    },
    [handleSubmit],
  );

  const handleDpadButtonPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
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

    requestAbortRef.current?.abort();
    void connect(sessionRef.current ? "resume" : "start");
  }, [connect, scheduleTerminalSizeBurst]);

  useTerminalPaneEffects({
    connect,
    dpadPosition,
    isActive,
    isConnected,
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
      handleDpadButtonPointerDown={handleDpadButtonPointerDown}
      handleDpadPointerCancel={handleDpadPointerCancel}
      handleDpadPointerDown={handleDpadPointerDown}
      handleDpadPointerMove={handleDpadPointerMove}
      handleDpadPointerUp={handleDpadPointerUp}
      handleFileSelection={handleFileSelection}
      handleKeyDown={handleKeyDown}
      handleQuickKeyPointerDown={handleQuickKeyPointerDown}
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
