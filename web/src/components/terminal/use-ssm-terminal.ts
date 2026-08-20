"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionState, SessionInfo } from "./types";
import { useTerminalResize } from "./use-terminal-resize";

interface Options {
  container: HTMLDivElement | null;
  tmuxSession: string;
  active: boolean;
}

interface TerminalController {
  state: ConnectionState;
  error: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  send: (text: string) => Promise<void>;
}

const FONT_SIZE = 13;
const SESSION_TIMEOUT_MS = 20_000;

async function readSession(response: Response): Promise<SessionInfo> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & Partial<SessionInfo>;
  if (!response.ok) {
    throw new Error(body.error || "Could not start terminal session");
  }
  if (
    !body.sessionId ||
    !body.streamUrl ||
    !body.tokenValue ||
    !body.terminateToken
  ) {
    throw new Error("Terminal service returned an incomplete session");
  }
  return body as SessionInfo;
}

function endSession(session: SessionInfo | null): void {
  if (!session) return;
  void fetch("/api/session/terminate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      terminateToken: session.terminateToken,
    }),
    credentials: "same-origin",
    keepalive: true,
  });
}

export function useSsmTerminal({
  container,
  tmuxSession,
  active,
}: Options): TerminalController {
  const [state, setState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState("");
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<SessionInfo | null>(null);
  const sequenceRef = useRef(0);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useTerminalResize({
    active,
    container,
    fit: fitRef,
    socket: socketRef,
    terminal: terminalRef,
  });

  const disconnect = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitRef.current = null;
    endSession(sessionRef.current);
    sessionRef.current = null;
    sequenceRef.current = 0;
    setState("disconnected");
  }, []);

  const connect = useCallback(async () => {
    disconnect();
    const generation = generationRef.current;
    const abort = new AbortController();
    abortRef.current = abort;
    setState("connecting");
    setError("");

    try {
      const [{ Terminal }, { FitAddon }, { ssm }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("ssm-session"),
      ]);
      if (generation !== generationRef.current || !container) return;

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: FONT_SIZE,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        scrollback: 20_000,
        theme: { background: "#171717", foreground: "#f5f5f5" },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      container.replaceChildren();
      terminal.open(container);
      fit.fit();
      terminalRef.current = terminal;
      fitRef.current = fit;

      const timeout = window.setTimeout(
        () => abort.abort(),
        SESSION_TIMEOUT_MS,
      );
      const response = await fetch("/api/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmuxSession,
          termOptions: { cols: terminal.cols, rows: terminal.rows },
        }),
        credentials: "same-origin",
        signal: abort.signal,
      }).finally(() => window.clearTimeout(timeout));
      const session = await readSession(response);
      if (generation !== generationRef.current) {
        endSession(session);
        return;
      }
      sessionRef.current = session;

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const socket = new WebSocket(session.streamUrl);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        sequenceRef.current = 0;
        ssm.init(socket, {
          token: session.tokenValue,
          termOptions: { cols: terminal.cols, rows: terminal.rows },
        });
      });
      socket.addEventListener("message", (event) => {
        const message = ssm.decode(event.data);
        ssm.sendACK(socket, message);
        if (message.payloadType === 1) {
          terminal.write(decoder.decode(message.payload));
          setState("connected");
        } else if (message.payloadType === 17) {
          ssm.sendInitMessage(socket, {
            cols: terminal.cols,
            rows: terminal.rows,
          });
          setState("connected");
        }
      });
      socket.addEventListener("close", () => {
        if (generation === generationRef.current) {
          setState("disconnected");
        }
      });
      socket.addEventListener("error", () => {
        if (generation === generationRef.current) {
          setState("error");
          setError("The terminal connection was interrupted.");
        }
      });
      terminal.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          ssm.sendText(socket, encoder.encode(data), sequenceRef.current++);
        }
      });
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setState("error");
      setError(
        caught instanceof DOMException && caught.name === "AbortError"
          ? "The terminal connection timed out."
          : caught instanceof Error
            ? caught.message
            : "Could not connect to the runtime.",
      );
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  }, [container, disconnect, tmuxSession]);

  const send = useCallback(async (text: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const { ssm } = await import("ssm-session");
    ssm.sendText(socket, new TextEncoder().encode(text), sequenceRef.current++);
  }, []);

  useEffect(() => {
    if (!container) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void connect();
    });
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [connect, container, disconnect]);

  return { state, error, connect, disconnect, send };
}
