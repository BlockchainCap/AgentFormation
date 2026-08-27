"use client";

import {
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

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

export type ConnectionState =
  "idle" | "connecting" | "resuming" | "connected" | "error";
export type ConnectMode = "start" | "resume";
export type TerminalScrollAxis = "horizontal" | "vertical";

export const DEFAULT_TMUX_SESSION = "code";
export const SESSION_REQUEST_TIMEOUT_MS = 20_000;
export const RECENT_CLOSED_TABS_LIMIT = 20;
export const MAX_TERMINAL_TABS = 8;
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
export const TERMINAL_MIN_COLUMNS = 20;
export const TERMINAL_MIN_ROWS = 5;
export const TERMINAL_GESTURE_LOCK_PX = 8;
export const TMUX_SESSION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const WEB_LINK_START_REGEX = /https?:\/\/[^\s"'<>`]+/g;
export const WEB_LINK_CONTINUATION_REGEX =
  /^([A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/;
export const WEB_LINK_MAX_CONTINUATION_LINES = 16;
export const WEB_LINK_MAX_CHARACTERS = 4_096;
export const WEB_LINK_CONTROL_OR_SPACE_REGEX = /[\u0000-\u0020\u007f]+/g;
const DEFAULT_TABS: readonly TerminalTab[] = [
  {
    id: DEFAULT_TMUX_SESSION,
    label: "Code",
    tmuxSession: DEFAULT_TMUX_SESSION,
  },
];

function createDefaultTabs(): TerminalTab[] {
  return DEFAULT_TABS.map((tab) => ({ ...tab }));
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

export function createFreshTerminalTab(labelIndex: number): TerminalTab {
  const suffix = Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const tmuxSession = `${DEFAULT_TMUX_SESSION}-${suffix}`;

  return {
    id: tmuxSession,
    label: `Code ${labelIndex}`,
    tmuxSession,
  };
}

export function normalizeTerminalTabs(
  value: unknown,
  limit = MAX_TERMINAL_TABS,
): TerminalTab[] {
  if (!Array.isArray(value)) {
    return [];
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

    if (!TMUX_SESSION_PATTERN.test(tab.tmuxSession)) return [];
    const tmuxSession = tab.tmuxSession;
    if (seenSessions.has(tmuxSession)) return [];

    seenSessions.add(tmuxSession);
    return [
      {
        id: tmuxSession,
        label: tab.label.trim().slice(0, 24).trim() || tmuxSession,
        tmuxSession,
      },
    ];
  });

  return tabs.slice(0, limit);
}

export function getNextTerminalTabLabelIndex(tabs: TerminalTab[]) {
  return tabs.reduce((nextIndex, tab) => {
    if (tab.label === "Code") {
      return Math.max(nextIndex, 2);
    }

    const match = tab.label.match(/^Code ([1-9][0-9]*)$/);
    if (!match) return nextIndex;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(parsed) && parsed < Number.MAX_SAFE_INTEGER
      ? Math.max(nextIndex, parsed + 1)
      : nextIndex;
  }, 2);
}

export interface InitialTerminalState {
  activeTabId: string;
  closedTabs: TerminalTab[];
  mountedTabIds: string[];
  nextTabLabelIndex: number;
  tabs: TerminalTab[];
}

export const TERMINAL_STORAGE_PREFIX = "mobile-terminal-tabs:";

export function clearStoredTerminalStates(storage: Storage): void {
  const terminalKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(TERMINAL_STORAGE_PREFIX)) terminalKeys.push(key);
  }
  for (const key of terminalKeys) storage.removeItem(key);
}

export function loadStoredTerminalState(
  storageKey: string,
  storage: Pick<Storage, "getItem"> = window.localStorage,
): InitialTerminalState {
  try {
    const stored = storage.getItem(storageKey);
    if (!stored) {
      const tabs = createDefaultTabs();
      return {
        activeTabId: tabs[0].id,
        closedTabs: [],
        mountedTabIds: [tabs[0].id],
        nextTabLabelIndex: 2,
        tabs,
      };
    }

    const parsed = JSON.parse(stored) as unknown;
    const parsedRecord =
      parsed && !Array.isArray(parsed) && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const storedTabs = Array.isArray(parsed) ? parsed : parsedRecord?.tabs;
    const storedClosedTabs = parsedRecord?.closedTabs;
    const normalizedTabs = normalizeTerminalTabs(storedTabs);
    const tabs = normalizedTabs.length ? normalizedTabs : createDefaultTabs();
    const closedTabs = Array.isArray(storedClosedTabs)
      ? normalizeTerminalTabs(storedClosedTabs, RECENT_CLOSED_TABS_LIMIT)
          .filter((tab) => !tabs.some((openTab) => openTab.id === tab.id))
          .slice(0, RECENT_CLOSED_TABS_LIMIT)
      : [];
    const storedActiveTabId = parsedRecord?.activeTabId;
    const activeTabId =
      typeof storedActiveTabId === "string" &&
      tabs.some((tab) => tab.id === storedActiveTabId)
        ? storedActiveTabId
        : tabs[0].id;
    const nextTabLabelIndex = getNextTerminalTabLabelIndex([
      ...tabs,
      ...closedTabs,
    ]);

    return {
      activeTabId,
      closedTabs,
      mountedTabIds: [activeTabId],
      nextTabLabelIndex,
      tabs,
    };
  } catch {
    const tabs = createDefaultTabs();
    return {
      activeTabId: tabs[0].id,
      closedTabs: [],
      mountedTabIds: [tabs[0].id],
      nextTabLabelIndex: 2,
      tabs,
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
    TERMINAL_MIN_COLUMNS,
    Math.min(
      TERMINAL_MAX_COLUMNS,
      Math.floor(container.clientWidth / cellWidth),
    ),
  );
}

export function getTerminalLineText(
  terminal: import("@xterm/xterm").Terminal,
  rowIndex: number,
) {
  return (
    terminal.buffer.active.getLine(rowIndex)?.translateToString(true) ?? ""
  );
}

function getTerminalCellForStringIndex(
  line: import("@xterm/xterm").IBufferLine,
  stringIndex: number,
): { column: number; width: number } | null {
  if (!Number.isSafeInteger(stringIndex) || stringIndex < 0) return null;

  let translatedIndex = 0;
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell) continue;
    const width = cell.getWidth();
    if (width === 0) continue;
    const characters = cell.getChars() || " ";
    if (stringIndex < translatedIndex + characters.length) {
      return { column, width };
    }
    translatedIndex += characters.length;
  }

  return null;
}

function getTerminalColumnsForStringRange(
  line: import("@xterm/xterm").IBufferLine,
  startStringIndex: number,
  endStringIndex: number,
): { startColumnIndex: number; endColumnIndex: number } | null {
  if (endStringIndex <= startStringIndex) return null;
  const startCell = getTerminalCellForStringIndex(line, startStringIndex);
  const endCell = getTerminalCellForStringIndex(line, endStringIndex - 1);
  if (!startCell || !endCell) return null;

  return {
    startColumnIndex: startCell.column,
    endColumnIndex: endCell.column + endCell.width - 1,
  };
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
  startStringIndex: number,
  firstSegment: string,
) {
  const startLine = terminal.buffer.active.getLine(startRowIndex);
  if (!startLine) return null;
  const firstRange = getTerminalColumnsForStringRange(
    startLine,
    startStringIndex,
    startStringIndex + firstSegment.length,
  );
  if (!firstRange) return null;

  let text = firstSegment;
  let endRowIndex = startRowIndex;
  let endColumnIndex = firstRange.endColumnIndex;
  let currentRowIndex = startRowIndex;
  let currentSegment = firstSegment;
  let continuationLines = 0;

  while (
    currentSegment.length > 0 &&
    continuationLines < WEB_LINK_MAX_CONTINUATION_LINES &&
    currentRowIndex + 1 < terminal.buffer.active.length
  ) {
    const nextLine = terminal.buffer.active.getLine(currentRowIndex + 1);
    if (!nextLine?.isWrapped) break;
    const nextLineText = nextLine.translateToString(true);
    const continuation = nextLineText.match(WEB_LINK_CONTINUATION_REGEX)?.[1];
    const continuationRange = continuation
      ? getTerminalColumnsForStringRange(nextLine, 0, continuation.length)
      : null;

    if (
      !continuation ||
      !continuationRange ||
      text.length + continuation.length > WEB_LINK_MAX_CHARACTERS
    ) {
      break;
    }

    text += continuation;
    continuationLines += 1;
    currentRowIndex += 1;
    currentSegment = continuation;
    endRowIndex = currentRowIndex;
    endColumnIndex = continuationRange.endColumnIndex;
  }

  return {
    text,
    range: {
      start: {
        x: firstRange.startColumnIndex + 1,
        y: startRowIndex + 1,
      },
      end: {
        x: endColumnIndex + 1,
        y: endRowIndex + 1,
      },
    },
  };
}

function getTerminalUrlCandidates(
  terminal: import("@xterm/xterm").Terminal,
  targetRowIndex: number,
) {
  const candidates: NonNullable<ReturnType<typeof collectTerminalUrl>>[] = [];
  const startRowIndex = Math.max(
    0,
    targetRowIndex - WEB_LINK_MAX_CONTINUATION_LINES,
  );

  for (
    let rowIndex = startRowIndex;
    rowIndex <= targetRowIndex;
    rowIndex += 1
  ) {
    const line = terminal.buffer.active.getLine(rowIndex);
    if (!line) continue;
    const lineText = line.translateToString(true);
    const linkPattern = new RegExp(
      WEB_LINK_START_REGEX.source,
      WEB_LINK_START_REGEX.flags,
    );

    for (const match of lineText.matchAll(linkPattern)) {
      const candidate = collectTerminalUrl(
        terminal,
        rowIndex,
        match.index ?? 0,
        match[0],
      );
      if (!candidate) continue;
      const text = normalizeTerminalUrlText(candidate.text);
      if (text) candidates.push({ ...candidate, text });
    }
  }

  return candidates;
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

  for (const candidate of getTerminalUrlCandidates(terminal, bufferRowIndex)) {
    if (terminalRangeContainsPoint(candidate.range, rowNumber, columnNumber)) {
      return candidate.text;
    }
  }

  return null;
}

export function createWrappedUrlLinkProvider(
  terminal: import("@xterm/xterm").Terminal,
): import("@xterm/xterm").ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const targetRowIndex = bufferLineNumber - 1;
      const links: import("@xterm/xterm").ILink[] = [];

      for (const candidate of getTerminalUrlCandidates(
        terminal,
        targetRowIndex,
      )) {
        if (
          candidate.range.start.y <= bufferLineNumber &&
          candidate.range.end.y >= bufferLineNumber
        ) {
          links.push({
            range: candidate.range,
            text: candidate.text,
            activate: openTerminalLink,
          });
        }
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
