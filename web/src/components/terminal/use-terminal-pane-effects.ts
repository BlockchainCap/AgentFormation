"use client";

import {
  useEffect,
  useEffectEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Terminal } from "@xterm/xterm";
import { beaconTerminateSession, type SessionInfo } from "./terminal-api";
import {
  TERMINAL_GESTURE_LOCK_PX,
  TERMINAL_TOUCH_SCROLL_LINE_PX,
  TERMINAL_VERTICAL_PADDING_PX,
  clampDpadPosition,
  getDefaultDpadPosition,
  getDominantScrollAxis,
  getTerminalUrlAtPoint,
  openTerminalUrl,
  type ConnectMode,
  type ConnectionState,
  type DpadPosition,
  type TerminalScrollAxis,
} from "./terminal-shared";

interface TerminalPaneEffectsProps {
  connect: (mode?: ConnectMode) => Promise<void>;
  dpadPosition: DpadPosition | null;
  isActive: boolean;
  reconnectIfNeeded: () => void;
  resetTransport: (mode: "fresh" | "resume" | "background" | "unmount") => void;
  scheduleTerminalSizeBurst: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  sessionRef: RefObject<SessionInfo | null>;
  setDpadPosition: Dispatch<SetStateAction<DpadPosition | null>>;
  setTerminalHeight: Dispatch<SetStateAction<number | null>>;
  state: ConnectionState;
  termRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
  updateTerminalReviewState: () => boolean;
}

export function useTerminalPaneEffects({
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
}: TerminalPaneEffectsProps) {
  // iOS Safari doesn't blur inputs on outside taps; dismiss keyboard manually
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement.tagName === "INPUT" &&
        !target.closest("input") &&
        !target.closest("button")
      ) {
        document.activeElement.blur();
      }
    };
    document.addEventListener("touchstart", handleTouchStart);
    return () => document.removeEventListener("touchstart", handleTouchStart);
  }, []);

  // Resize terminal when viewport changes (keyboard open/close)
  useEffect(() => {
    if (!isActive) return;

    const updateTerminalHeight = () => {
      const scrollContainer = scrollRef.current;
      if (!scrollContainer) return;

      setTerminalHeight(
        Math.max(
          1,
          scrollContainer.clientHeight - TERMINAL_VERTICAL_PADDING_PX,
        ),
      );
    };

    updateTerminalHeight();

    const scrollResizeObserver =
      typeof ResizeObserver === "function" && scrollRef.current
        ? new ResizeObserver(updateTerminalHeight)
        : null;
    if (scrollRef.current) {
      scrollResizeObserver?.observe(scrollRef.current);
    }

    const handleResize = () => {
      updateTerminalHeight();
      scheduleTerminalSizeBurst();
    };

    const resizeObserver =
      typeof ResizeObserver === "function" && termRef.current
        ? new ResizeObserver(handleResize)
        : null;
    if (termRef.current) {
      resizeObserver?.observe(termRef.current);
    }

    window.visualViewport?.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("scroll", handleResize);
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      scrollResizeObserver?.disconnect();
      resizeObserver?.disconnect();
      window.visualViewport?.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("scroll", handleResize);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, [
    isActive,
    scheduleTerminalSizeBurst,
    scrollRef,
    setTerminalHeight,
    termRef,
  ]);

  // Re-fit when terminal becomes visible
  useEffect(() => {
    if (isActive && state === "connected") {
      scheduleTerminalSizeBurst();
    }
  }, [isActive, scheduleTerminalSizeBurst, state]);

  useEffect(() => {
    if (!isActive || state !== "connected" || dpadPosition) return;
    const frame = window.requestAnimationFrame(() => {
      setDpadPosition(getDefaultDpadPosition());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dpadPosition, isActive, setDpadPosition, state]);

  useEffect(() => {
    if (!isActive) return;

    const handleResize = () => {
      setDpadPosition((position) =>
        position ? clampDpadPosition(position) : getDefaultDpadPosition(),
      );
    };

    window.visualViewport?.addEventListener("resize", handleResize);
    window.addEventListener("resize", handleResize);
    return () => {
      window.visualViewport?.removeEventListener("resize", handleResize);
      window.removeEventListener("resize", handleResize);
    };
  }, [isActive, setDpadPosition]);

  useEffect(() => {
    if (!isActive) return;

    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;

    scrollContainer.scrollLeft = 0;

    let touchStartX = 0;
    let touchStartY = 0;
    let touchLastX = 0;
    let touchLastY = 0;
    let touchResidualY = 0;
    let touchAxis: TerminalScrollAxis | null = null;
    let hasTrackedTouch = false;
    const scrollTerminalLines = (
      lines: number,
      clientX: number,
      clientY: number,
    ) => {
      const terminal = terminalRef.current;
      if (!terminal || lines === 0) return;

      if (!terminal.element || typeof WheelEvent !== "function") {
        terminal.scrollLines(lines);
        updateTerminalReviewState();
        return;
      }

      terminal.element.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: lines,
        }),
      );
    };

    const handleTouchStart = (event: TouchEvent) => {
      hasTrackedTouch = event.touches.length === 1;
      if (!hasTrackedTouch) return;

      touchStartX = event.touches[0].clientX;
      touchStartY = event.touches[0].clientY;
      touchLastX = touchStartX;
      touchLastY = touchStartY;
      touchResidualY = 0;
      touchAxis = null;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!hasTrackedTouch || event.touches.length !== 1) {
        hasTrackedTouch = false;
        return;
      }

      const nextX = event.touches[0].clientX;
      const nextY = event.touches[0].clientY;
      const deltaX = touchLastX - nextX;
      const deltaY = touchLastY - nextY;
      touchLastX = nextX;
      touchLastY = nextY;

      if (!touchAxis) {
        const totalX = nextX - touchStartX;
        const totalY = nextY - touchStartY;
        if (
          Math.max(Math.abs(totalX), Math.abs(totalY)) <
          TERMINAL_GESTURE_LOCK_PX
        ) {
          return;
        }
        touchAxis = getDominantScrollAxis(totalX, totalY);
        scrollContainer.classList.add("terminal-touch-scrolling");
      }

      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (touchAxis === "horizontal") {
        scrollContainer.scrollLeft += deltaX;
        return;
      }

      touchResidualY += deltaY;
      if (Math.abs(touchResidualY) < TERMINAL_TOUCH_SCROLL_LINE_PX) return;

      const lines = Math.trunc(touchResidualY / TERMINAL_TOUCH_SCROLL_LINE_PX);
      touchResidualY -= lines * TERMINAL_TOUCH_SCROLL_LINE_PX;
      scrollTerminalLines(lines, nextX, nextY);
    };

    const handleTouchEnd = () => {
      if (hasTrackedTouch && !touchAxis) {
        const terminal = terminalRef.current;
        const terminalContainer = termRef.current;
        if (terminal && terminalContainer) {
          const urlText = getTerminalUrlAtPoint(
            terminal,
            terminalContainer,
            touchStartX,
            touchStartY,
          );
          if (urlText) openTerminalUrl(urlText);
        }
      }

      touchResidualY = 0;
      touchAxis = null;
      hasTrackedTouch = false;
      scrollContainer.classList.remove("terminal-touch-scrolling");
    };

    const handleTouchCancel = () => {
      touchResidualY = 0;
      touchAxis = null;
      hasTrackedTouch = false;
      scrollContainer.classList.remove("terminal-touch-scrolling");
    };

    scrollContainer.addEventListener("touchstart", handleTouchStart, {
      capture: true,
      passive: false,
    });
    scrollContainer.addEventListener("touchmove", handleTouchMove, {
      capture: true,
      passive: false,
    });
    scrollContainer.addEventListener("touchend", handleTouchEnd, {
      capture: true,
    });
    scrollContainer.addEventListener("touchcancel", handleTouchCancel, {
      capture: true,
    });

    return () => {
      scrollContainer.removeEventListener("touchstart", handleTouchStart, {
        capture: true,
      });
      scrollContainer.removeEventListener("touchmove", handleTouchMove, {
        capture: true,
      });
      scrollContainer.removeEventListener("touchend", handleTouchEnd, {
        capture: true,
      });
      scrollContainer.removeEventListener("touchcancel", handleTouchCancel, {
        capture: true,
      });
      scrollContainer.classList.remove("terminal-touch-scrolling");
    };
  }, [isActive, scrollRef, termRef, terminalRef, updateTerminalReviewState]);

  const startConnection = useEffectEvent(() => connect("start"));
  const reconnectAfterResume = useEffectEvent(() => reconnectIfNeeded());
  const suspendConnection = useEffectEvent(() => {
    const activeSession = sessionRef.current;
    if (activeSession?.sessionId && activeSession.terminateToken) {
      sessionRef.current = null;
      beaconTerminateSession(
        activeSession.sessionId,
        activeSession.terminateToken,
      );
    }
    resetTransport("background");
  });
  const unmountConnection = useEffectEvent(() => resetTransport("unmount"));

  // Auto-connect on mount; detach before mobile browsers suspend the page.
  useEffect(() => {
    void startConnection().catch(() => {
      // connect reports a user-safe error and owns its cleanup path.
    });

    const handlePageHide = () => suspendConnection();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        reconnectAfterResume();
      } else {
        suspendConnection();
      }
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reconnectAfterResume();
    };

    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      unmountConnection();
    };
  }, []);
}
