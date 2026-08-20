"use client";

import { useEffect } from "react";

interface Options {
  active: boolean;
  container: HTMLDivElement | null;
  fit: React.RefObject<import("@xterm/addon-fit").FitAddon | null>;
  socket: React.RefObject<WebSocket | null>;
  terminal: React.RefObject<import("@xterm/xterm").Terminal | null>;
}

export function useTerminalResize({
  active,
  container,
  fit,
  socket,
  terminal,
}: Options): void {
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => fit.current?.fit());
    return () => cancelAnimationFrame(frame);
  }, [active, fit]);

  useEffect(() => {
    if (!container) return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        fit.current?.fit();
        const currentTerminal = terminal.current;
        const currentSocket = socket.current;
        if (
          !currentTerminal ||
          !currentSocket ||
          currentSocket.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        void import("ssm-session").then(({ ssm }) => {
          ssm.sendInitMessage(currentSocket, {
            cols: currentTerminal.cols,
            rows: currentTerminal.rows,
          });
        });
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [container, fit, socket, terminal]);
}
