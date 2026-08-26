"use client";

import {
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

export interface SessionInfo {
  sessionId: string;
  streamUrl: string;
  tokenValue: string;
  terminateToken: string;
  instanceId?: string;
  bootstrapText?: string;
}

export interface TerminalTab {
  id: string;
  label: string;
  tmuxSession: string;
}

export interface MobileTerminalProps {
  storageScope: string;
}

export interface TerminalPaneProps {
  tmuxSession: string;
  isActive: boolean;
}

export interface UploadCreateResponse {
  key: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  uploadUrl: string;
  method: "PUT";
  requiredHeaders: Record<string, string>;
}

export interface UploadCompleteResponse {
  path: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}

export interface PendingAttachment extends UploadCompleteResponse {
  id: string;
}

export type ConnectionState =
  "idle" | "connecting" | "resuming" | "connected" | "error";
export type ConnectMode = "start" | "resume";
export type TerminalScrollAxis = "horizontal" | "vertical";
export type UploadStatus =
  | { state: "idle" }
  | { state: "uploading"; filename: string; progress: number }
  | { state: "completing"; filename: string };

export const DEFAULT_TMUX_SESSION = "code";
export const SESSION_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_ATTACHMENT_UPLOAD_BYTES = 50 * 1024 * 1024;
export const RECENT_CLOSED_TABS_LIMIT = 20;
export const XTERM_SCROLLBACK_LINES = 100_000;
export const TERMINAL_MAX_COLUMNS = 132;
export const TERMINAL_MAX_WIDTH_FACTOR = 1.25;
export const TERMINAL_FONT_SIZE = 12;
export const TERMINAL_LINE_HEIGHT = 1.25;
export const TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace";
export const TERMINAL_SCROLL_LINE_PX =
  TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT;
export const TERMINAL_TOUCH_SCROLL_LINE_PX = TERMINAL_SCROLL_LINE_PX;
export const TERMINAL_SCROLL_OPTIONS = {
  scrollSensitivity: 0.2,
  fastScrollSensitivity: 5,
} as const;
export const TERMINAL_VERTICAL_PADDING_PX = 16;
export const TERMINAL_GESTURE_LOCK_PX = 8;
export const TMUX_SESSION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const WEB_LINK_START_REGEX = /https?:\/\/[^\s"'<>`]+/g;
export const WEB_LINK_CONTINUATION_REGEX =
  /^([A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/;
export const WEB_LINK_CONTEXT_LINES = 32;
export const WEB_LINK_CONTROL_OR_SPACE_REGEX = /[\u0000-\u0020\u007f]+/g;
export const STARTUP_PROFILE_ECHO_MARKERS = [
  "set +o history",
  "unset HISTFILE",
  "export HISTCONTROL=",
  "set -e",
  "stty -echo",
  "REMOTE_USER=",
  "REMOTE_HOME=",
  "export HOME=",
  "export USER=",
  "export LOGNAME=",
  "export SHELL=",
  "export PATH=",
  "TMUX_SESSION=",
  "REMOTE_WORKSPACE=",
  'mkdir -p "$REMOTE_WORKSPACE/projects"',
  "ln -sfn /usr/local/bin/claude",
  'printf "%s\\n" "Welcome to AgentFormation',
  'cd "$REMOTE_WORKSPACE"',
  "if ! command -v tmux",
  "exec /bin/bash -l",
  "tmux set-option",
  "tmux set-window-option",
  "tmux set-environment",
  "if tmux has-session",
  "exec tmux attach-session",
  "exec tmux new-session",
  "$TMUX_SESSION",
  "$REMOTE_WORKSPACE",
];
export const DEFAULT_TABS: TerminalTab[] = [
  {
    id: DEFAULT_TMUX_SESSION,
    label: "Code",
    tmuxSession: DEFAULT_TMUX_SESSION,
  },
];

export function normalizeTmuxSessionName(sessionName: string) {
  return TMUX_SESSION_PATTERN.test(sessionName)
    ? sessionName
    : DEFAULT_TMUX_SESSION;
}

export const QUICK_KEYS: { label: string; seq?: string; action?: "clear" }[] = [
  { label: "Tab", seq: "\t" },
  { label: "Esc", seq: "\x1b" },
  { label: "Ctrl+C", seq: "\x03" },
  { label: "Ctrl+O", seq: "\x0f" },
  { label: "Clear", action: "clear" },
  { label: "New Line", seq: "\n" },
];

export const CLEAR_LINE = "\x15";
export const CLEAR_TERMINAL_INPUT = "\x15\x0b";
export const DPAD_WIDTH_PX = 102;
export const DPAD_HEIGHT_PX = 70;
export const DPAD_MARGIN_PX = 8;
export const DPAD_DEFAULT_BOTTOM_PX = 116;

export type DpadPosition = { x: number; y: number };
export type TerminalBufferPoint = { column: number; row: number };

export function normalizeTerminalUrlText(uri: string) {
  return uri.replace(WEB_LINK_CONTROL_OR_SPACE_REGEX, "");
}

export function openTerminalUrl(uri: string) {
  const normalizedUri = normalizeTerminalUrlText(uri);
  let url: URL;
  try {
    url = new URL(normalizedUri);
  } catch {
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  window.open(url.href, "_blank", "noopener,noreferrer");
}

export function openTerminalLink(event: MouseEvent, uri: string) {
  event.preventDefault();
  openTerminalUrl(uri);
}

export const terminalLinkHandler = {
  activate: openTerminalLink,
  allowNonHttpProtocols: false,
};

export async function readJsonResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(
      body.error ?? `Request failed with status ${response.status}`,
    );
  }

  return body as T;
}

export function uploadFileToUrl(
  file: File,
  uploadUrl: string,
  requiredHeaders: Record<string, string>,
  onProgress: (progress: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    Object.entries(requiredHeaders).forEach(([name, value]) => {
      xhr.setRequestHeader(name, value);
    });
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }

      reject(new Error(`Upload failed with status ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}

export function getUploadStatusText(
  uploadStatus: UploadStatus,
  uploadError: string,
) {
  if (uploadError) return uploadError;
  if (uploadStatus.state === "uploading") {
    return `Uploading ${uploadStatus.filename} (${uploadStatus.progress}%)`;
  }
  if (uploadStatus.state === "completing") {
    return `Installing ${uploadStatus.filename} on runtime...`;
  }

  return "";
}

export function getAttachmentPromptText(upload: UploadCompleteResponse) {
  return `attached file: ${upload.path}`;
}

export function getAttachmentSubmitSuffix(
  inputValue: string,
  attachments: PendingAttachment[],
) {
  if (attachments.length === 0) return "";

  const prefix = inputValue.length === 0 || /\s$/.test(inputValue) ? "" : " ";
  return `${prefix}${attachments.map(getAttachmentPromptText).join(" ")} `;
}

export function getTerminalTheme(isDark: boolean) {
  return isDark
    ? {
        background: "#1a1a1a",
        foreground: "#e5e5e5",
        cursor: "#a78bfa",
        selectionBackground: "#a78bfa44",
        black: "#1a1a1a",
        brightBlack: "#404040",
      }
    : {
        background: "#f4f4f4",
        foreground: "#383a42",
        cursor: "#7c3aed",
        selectionBackground: "#7c3aed33",
        black: "#f4f4f4",
        brightBlack: "#a0a1a7",
      };
}

export function buildInputEditSequence(
  previousValue: string,
  nextValue: string,
  nextCursorIndex: number,
) {
  const isCursorAtEnd = nextCursorIndex === nextValue.length;

  if (isCursorAtEnd && nextValue.startsWith(previousValue)) {
    return nextValue.slice(previousValue.length);
  }

  if (isCursorAtEnd && previousValue.startsWith(nextValue)) {
    return "\x7f".repeat(previousValue.length - nextValue.length);
  }

  return CLEAR_LINE + nextValue;
}

export function isSubmitShortcut(event: ReactKeyboardEvent<HTMLInputElement>) {
  return event.metaKey || event.ctrlKey || event.getModifierState("Meta");
}

export function createTerminalTab(index: number): TerminalTab {
  const tmuxSession =
    index === 1 ? DEFAULT_TMUX_SESSION : `${DEFAULT_TMUX_SESSION}-${index}`;

  return {
    id: tmuxSession,
    label: index === 1 ? "Code" : `Code ${index}`,
    tmuxSession,
  };
}

export function normalizeTerminalTabs(value: unknown): TerminalTab[] {
  if (!Array.isArray(value)) {
    return DEFAULT_TABS;
  }

  const seenSessions = new Set<string>();
  const tabs = value.flatMap((item): TerminalTab[] => {
    if (!item || typeof item !== "object") return [];

    const tab = item as Record<string, unknown>;
    if (
      typeof tab.id !== "string" ||
      typeof tab.label !== "string" ||
      typeof tab.tmuxSession !== "string"
    ) {
      return [];
    }

    const tmuxSession = normalizeTmuxSessionName(tab.tmuxSession);
    if (seenSessions.has(tmuxSession)) return [];

    seenSessions.add(tmuxSession);
    return [
      {
        id: tmuxSession,
        label: tab.label.slice(0, 24) || tmuxSession,
        tmuxSession,
      },
    ];
  });

  return tabs.length ? tabs : DEFAULT_TABS;
}

export function getNextTerminalTabIndex(tabs: TerminalTab[]) {
  return tabs.reduce((nextIndex, tab) => {
    if (tab.tmuxSession === DEFAULT_TMUX_SESSION) {
      return Math.max(nextIndex, 2);
    }

    const match = tab.tmuxSession.match(/^code-(\d+)$/);
    return match
      ? Math.max(nextIndex, Number.parseInt(match[1], 10) + 1)
      : nextIndex;
  }, 2);
}

export interface StoredTerminalState {
  activeTabId: string;
  closedTabs: TerminalTab[];
  mountedTabIds: string[];
  nextTabIndex: number;
  tabs: TerminalTab[];
}

export function loadStoredTerminalState(
  storageKey: string,
): StoredTerminalState {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) {
      return {
        activeTabId: DEFAULT_TABS[0].id,
        closedTabs: [],
        mountedTabIds: [DEFAULT_TABS[0].id],
        nextTabIndex: 2,
        tabs: DEFAULT_TABS,
      };
    }

    const parsed = JSON.parse(stored) as unknown;
    const storedTabs = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).tabs
        : null;
    const storedClosedTabs =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).closedTabs
        : null;
    const tabs = normalizeTerminalTabs(storedTabs);
    const closedTabs = Array.isArray(storedClosedTabs)
      ? normalizeTerminalTabs(storedClosedTabs)
          .filter((tab) => !tabs.some((openTab) => openTab.id === tab.id))
          .slice(0, RECENT_CLOSED_TABS_LIMIT)
      : [];
    const storedNextTabIndex =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).nextTabIndex
        : null;
    const storedActiveTabId =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).activeTabId
        : null;
    const activeTabId =
      typeof storedActiveTabId === "string" &&
      tabs.some((tab) => tab.id === storedActiveTabId)
        ? storedActiveTabId
        : tabs[0].id;
    const minimumNextTabIndex = getNextTerminalTabIndex([
      ...tabs,
      ...closedTabs,
    ]);

    return {
      activeTabId,
      closedTabs,
      mountedTabIds: [activeTabId],
      nextTabIndex:
        typeof storedNextTabIndex === "number" && storedNextTabIndex >= 2
          ? Math.max(storedNextTabIndex, minimumNextTabIndex)
          : minimumNextTabIndex,
      tabs,
    };
  } catch {
    return {
      activeTabId: DEFAULT_TABS[0].id,
      closedTabs: [],
      mountedTabIds: [DEFAULT_TABS[0].id],
      nextTabIndex: 2,
      tabs: DEFAULT_TABS,
    };
  }
}

export const subscribeToHydration = () => () => undefined;

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
}

export function getDefaultDpadPosition() {
  return {
    x: Math.max(
      DPAD_MARGIN_PX,
      window.innerWidth - DPAD_WIDTH_PX - DPAD_MARGIN_PX,
    ),
    y: Math.max(
      DPAD_MARGIN_PX,
      window.innerHeight - DPAD_HEIGHT_PX - DPAD_DEFAULT_BOTTOM_PX,
    ),
  };
}

export function clampDpadPosition(position: DpadPosition) {
  return {
    x: Math.min(
      Math.max(DPAD_MARGIN_PX, position.x),
      Math.max(
        DPAD_MARGIN_PX,
        window.innerWidth - DPAD_WIDTH_PX - DPAD_MARGIN_PX,
      ),
    ),
    y: Math.min(
      Math.max(DPAD_MARGIN_PX, position.y),
      Math.max(
        DPAD_MARGIN_PX,
        window.innerHeight - DPAD_HEIGHT_PX - DPAD_MARGIN_PX,
      ),
    ),
  };
}

export function terminateSession(sessionId: string, terminateToken: string) {
  const body = JSON.stringify({ sessionId, terminateToken });
  fetch("/api/session/terminate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
    credentials: "same-origin",
  }).catch(() => {
    if (typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(
        "/api/session/terminate",
        new Blob([body], { type: "application/json" }),
      );
    }
  });
}

export async function readSessionResponse(res: Response): Promise<SessionInfo> {
  const body = await res.json().catch(() => ({ error: "Unknown error" }));
  if (!res.ok) {
    throw new Error(
      typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
    );
  }

  if (
    typeof body.sessionId !== "string" ||
    typeof body.streamUrl !== "string" ||
    typeof body.tokenValue !== "string" ||
    typeof body.terminateToken !== "string" ||
    (body.bootstrapText !== undefined && typeof body.bootstrapText !== "string")
  ) {
    throw new Error("Incomplete SSM session response");
  }

  return body;
}

export function isTerminalAtBottom(
  terminal: import("@xterm/xterm").Terminal | null,
) {
  if (!terminal) return true;

  const buffer = terminal.buffer.active;
  return buffer.viewportY >= buffer.baseY;
}

export function getWheelScrollPixels(
  event: WheelEvent,
  container: HTMLElement,
) {
  const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return delta * TERMINAL_SCROLL_LINE_PX;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return delta * container.clientWidth;
  }

  return delta;
}

export function getDominantScrollAxis(
  deltaX: number,
  deltaY: number,
): TerminalScrollAxis | null {
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (Math.max(absX, absY) === 0) return null;

  return absX > absY ? "horizontal" : "vertical";
}

export function measureTerminalCellWidth(container: HTMLElement) {
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(20);
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.fontFamily = TERMINAL_FONT_FAMILY;
  probe.style.fontSize = `${TERMINAL_FONT_SIZE}px`;
  probe.style.lineHeight = String(TERMINAL_LINE_HEIGHT);
  container.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 20;
  probe.remove();

  return width || TERMINAL_FONT_SIZE * 0.6;
}

export function getTerminalColumnsForWidth(container: HTMLElement) {
  const cellWidth = measureTerminalCellWidth(container);
  return Math.max(
    1,
    Math.min(
      TERMINAL_MAX_COLUMNS,
      Math.floor(container.clientWidth / cellWidth),
    ),
  );
}

export function filterStartupProfileEchoes(text: string) {
  return text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !STARTUP_PROFILE_ECHO_MARKERS.some((marker) => line.includes(marker)),
    )
    .join("\n");
}

export function containsStartupProfileEcho(text: string) {
  return STARTUP_PROFILE_ECHO_MARKERS.some((marker) => text.includes(marker));
}

export function normalizeBootstrapText(text: string) {
  const normalized = filterStartupProfileEchoes(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!normalized) return "";

  return `\x1b[0m${normalized.replace(/\n/g, "\r\n")}\r\n`;
}

export function getTerminalLineText(
  terminal: import("@xterm/xterm").Terminal,
  rowIndex: number,
) {
  return (
    terminal.buffer.active.getLine(rowIndex)?.translateToString(true) ?? ""
  );
}

export function getTerminalBufferPoint(
  terminal: import("@xterm/xterm").Terminal,
  container: HTMLElement,
  clientX: number,
  clientY: number,
  clampToScreen = false,
): TerminalBufferPoint | null {
  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;

  const screenRect = screen.getBoundingClientRect();
  const outsideScreen =
    clientX < screenRect.left ||
    clientX > screenRect.right ||
    clientY < screenRect.top ||
    clientY > screenRect.bottom;
  if (outsideScreen && !clampToScreen) return null;

  const cellWidth = screenRect.width / terminal.cols;
  const cellHeight = screenRect.height / terminal.rows;
  if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight)) return null;
  if (cellWidth <= 0 || cellHeight <= 0) return null;

  const visibleColumn = Math.min(
    terminal.cols - 1,
    Math.max(0, Math.floor((clientX - screenRect.left) / cellWidth)),
  );
  const visibleRow = Math.min(
    terminal.rows - 1,
    Math.max(0, Math.floor((clientY - screenRect.top) / cellHeight)),
  );

  return {
    column: visibleColumn,
    row: terminal.buffer.active.viewportY + visibleRow,
  };
}

export function getTerminalSelectionRange(
  anchor: TerminalBufferPoint,
  focus: TerminalBufferPoint,
  columns: number,
) {
  const anchorIndex = anchor.row * columns + anchor.column;
  const focusIndex = focus.row * columns + focus.column;
  const startIndex = Math.min(anchorIndex, focusIndex);
  const endIndex = Math.max(anchorIndex, focusIndex);

  return {
    column: startIndex % columns,
    row: Math.floor(startIndex / columns),
    length: endIndex - startIndex + 1,
  };
}

export function collectTerminalUrl(
  terminal: import("@xterm/xterm").Terminal,
  startRowIndex: number,
  startColumnIndex: number,
  firstSegment: string,
) {
  let text = firstSegment;
  let endRowIndex = startRowIndex;
  let endColumnIndex = startColumnIndex + firstSegment.length - 1;
  let currentRowIndex = startRowIndex;
  let currentSegmentStartColumnIndex = startColumnIndex;
  let currentSegment = firstSegment;

  while (
    currentSegment.length > 0 &&
    currentRowIndex + 1 < terminal.buffer.active.length
  ) {
    const currentLineText = getTerminalLineText(terminal, currentRowIndex);
    const currentSegmentTouchesLineEnd =
      currentSegmentStartColumnIndex + currentSegment.length >=
      currentLineText.length;

    if (!currentSegmentTouchesLineEnd) break;

    const nextLineText = getTerminalLineText(terminal, currentRowIndex + 1);
    const leadingWhitespaceLength =
      nextLineText.length - nextLineText.trimStart().length;
    const continuation = nextLineText
      .slice(leadingWhitespaceLength)
      .match(WEB_LINK_CONTINUATION_REGEX)?.[1];

    if (!continuation) break;

    text += continuation;
    currentRowIndex += 1;
    currentSegmentStartColumnIndex = leadingWhitespaceLength;
    currentSegment = continuation;
    endRowIndex = currentRowIndex;
    endColumnIndex = leadingWhitespaceLength + continuation.length - 1;
  }

  return {
    text,
    range: {
      start: {
        x: startColumnIndex + 1,
        y: startRowIndex + 1,
      },
      end: {
        x: endColumnIndex + 1,
        y: endRowIndex + 1,
      },
    },
  };
}

export function terminalRangeContainsPoint(
  range: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  },
  rowNumber: number,
  columnNumber: number,
) {
  if (rowNumber < range.start.y || rowNumber > range.end.y) return false;
  if (range.start.y === range.end.y) {
    return columnNumber >= range.start.x && columnNumber <= range.end.x;
  }
  if (rowNumber === range.start.y) return columnNumber >= range.start.x;
  if (rowNumber === range.end.y) return columnNumber <= range.end.x;
  return true;
}

export function getTerminalUrlAtPoint(
  terminal: import("@xterm/xterm").Terminal,
  container: HTMLElement,
  clientX: number,
  clientY: number,
) {
  const point = getTerminalBufferPoint(terminal, container, clientX, clientY);
  if (!point) return null;

  const columnNumber = point.column + 1;
  const bufferRowIndex = point.row;
  const rowNumber = bufferRowIndex + 1;

  const startRowIndex = Math.max(0, bufferRowIndex - WEB_LINK_CONTEXT_LINES);
  const endRowIndex = Math.min(
    terminal.buffer.active.length - 1,
    bufferRowIndex + WEB_LINK_CONTEXT_LINES,
  );

  for (let rowIndex = startRowIndex; rowIndex <= endRowIndex; rowIndex += 1) {
    const lineText = getTerminalLineText(terminal, rowIndex);
    WEB_LINK_START_REGEX.lastIndex = 0;

    for (const match of lineText.matchAll(WEB_LINK_START_REGEX)) {
      const candidate = collectTerminalUrl(
        terminal,
        rowIndex,
        match.index ?? 0,
        match[0],
      );

      if (
        terminalRangeContainsPoint(candidate.range, rowNumber, columnNumber)
      ) {
        return candidate.text;
      }
    }
  }

  return null;
}

export function createWrappedUrlLinkProvider(
  terminal: import("@xterm/xterm").Terminal,
): import("@xterm/xterm").ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active;
      const targetRowIndex = bufferLineNumber - 1;
      const startRowIndex = Math.max(
        0,
        targetRowIndex - WEB_LINK_CONTEXT_LINES,
      );
      const endRowIndex = Math.min(
        buffer.length - 1,
        targetRowIndex + WEB_LINK_CONTEXT_LINES,
      );
      const links: import("@xterm/xterm").ILink[] = [];

      for (
        let rowIndex = startRowIndex;
        rowIndex <= endRowIndex;
        rowIndex += 1
      ) {
        const lineText = getTerminalLineText(terminal, rowIndex);
        WEB_LINK_START_REGEX.lastIndex = 0;

        for (const match of lineText.matchAll(WEB_LINK_START_REGEX)) {
          const matchIndex = match.index ?? 0;
          const candidate = collectTerminalUrl(
            terminal,
            rowIndex,
            matchIndex,
            match[0],
          );

          if (
            candidate.range.start.y <= bufferLineNumber &&
            candidate.range.end.y >= bufferLineNumber
          ) {
            const text = normalizeTerminalUrlText(candidate.text);
            if (!text) continue;

            links.push({
              range: candidate.range,
              text,
              activate: openTerminalLink,
            });
          }
        }
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
