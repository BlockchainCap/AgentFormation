import { describe, expect, it, vi } from "vitest";
import {
  buildInputEditSequence,
  clearStoredTerminalStates,
  collectTerminalUrl,
  createFreshTerminalTab,
  createWrappedUrlLinkProvider,
  getDominantScrollAxis,
  getTerminalSelectionRange,
  getTerminalUrlAtPoint,
  loadStoredTerminalState,
  normalizeTerminalTabs,
  openTerminalUrl,
  WEB_LINK_MAX_CONTINUATION_LINES,
  TERMINAL_SCROLL_OPTIONS,
} from "./terminal-shared";

type FakeTerminalCell = {
  characters: string;
  width: number;
};

function createAsciiCells(text: string): FakeTerminalCell[] {
  return [...text].map((characters) => ({ characters, width: 1 }));
}

function createFakeTerminalLine(cells: FakeTerminalCell[], isWrapped = false) {
  const text = cells
    .filter((cell) => cell.width !== 0)
    .map((cell) => cell.characters || " ")
    .join("");

  return {
    isWrapped,
    length: cells.length,
    getCell: (column: number) => {
      const cell = cells[column];
      if (!cell) return undefined;
      return {
        getChars: () => cell.characters,
        getWidth: () => cell.width,
      };
    },
    translateToString: (trimRight = false) =>
      trimRight ? text.replace(/ +$/, "") : text,
  };
}

function createFakeTerminal(
  lines: ReturnType<typeof createFakeTerminalLine>[],
) {
  return {
    cols: Math.max(...lines.map((line) => line.length)),
    rows: lines.length,
    buffer: {
      active: {
        length: lines.length,
        viewportY: 0,
        getLine: (index: number) => lines[index],
      },
    },
  } as unknown as import("@xterm/xterm").Terminal;
}

function createFakeTerminalContainer(columns: number, rows = 1) {
  const screen = {
    getBoundingClientRect: () => ({
      bottom: rows * 10,
      height: rows * 10,
      left: 0,
      right: columns * 10,
      top: 0,
      width: columns * 10,
    }),
  };

  return {
    querySelector: () => screen,
  } as unknown as HTMLElement;
}

describe("terminal tabs", () => {
  it("clears only terminal metadata during explicit sign-out", () => {
    const values = new Map([
      ["theme", "dark"],
      ["mobile-terminal-tabs:first", "{}"],
      ["mobile-terminal-tabs:second", "{}"],
    ]);
    const storage = {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
    } as unknown as Storage;

    clearStoredTerminalStates(storage);

    expect(values.get("theme")).toBe("dark");
    expect(values.has("mobile-terminal-tabs:first")).toBe(false);
    expect(values.has("mobile-terminal-tabs:second")).toBe(false);
  });

  it("drops unsafe persisted tmux names before they reach an API", () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          tabs: [{ id: "bad", label: "Bad", tmuxSession: "x; id" }],
        }),
    } as Pick<Storage, "getItem">;

    expect(loadStoredTerminalState("terminal", storage).tabs).toEqual([
      { id: "code", label: "Code", tmuxSession: "code" },
    ]);
  });

  it("returns a fresh default tab array for each invalid persisted value", () => {
    const storage = {
      getItem: () => JSON.stringify({ tabs: null }),
    } as Pick<Storage, "getItem">;
    const first = loadStoredTerminalState("terminal", storage).tabs;
    first[0].label = "Changed";

    expect(loadStoredTerminalState("terminal", storage).tabs).toEqual([
      { id: "code", label: "Code", tmuxSession: "code" },
    ]);
  });

  it("deduplicates sessions and trims labels to the UI limit", () => {
    expect(
      normalizeTerminalTabs([
        {
          id: "first",
          label: "A label that is intentionally much too long",
          tmuxSession: "code-2",
        },
        { id: "duplicate", label: "Duplicate", tmuxSession: "code-2" },
      ]),
    ).toEqual([
      {
        id: "code-2",
        label: "A label that is intentio",
        tmuxSession: "code-2",
      },
    ]);
  });

  it("gives every fresh non-default tab an unpredictable tmux session", () => {
    const first = createFreshTerminalTab(2);
    const second = createFreshTerminalTab(2);

    expect(first.label).toBe("Code 2");
    expect(first.tmuxSession).toMatch(/^code-[a-f0-9]{24}$/);
    expect(second.tmuxSession).toMatch(/^code-[a-f0-9]{24}$/);
    expect(second.tmuxSession).not.toBe(first.tmuxSession);
  });

  it("does not invent a recently closed default tab from empty or invalid storage", () => {
    for (const closedTabs of [
      [],
      [{ id: "bad", label: "Bad", tmuxSession: "x; id" }],
    ]) {
      const storage = {
        getItem: () =>
          JSON.stringify({
            activeTabId: "code-0123456789abcdef01234567",
            closedTabs,
            tabs: [
              {
                id: "code-0123456789abcdef01234567",
                label: "Code 2",
                tmuxSession: "code-0123456789abcdef01234567",
              },
            ],
          }),
      } as Pick<Storage, "getItem">;

      expect(loadStoredTerminalState("terminal", storage).closedTabs).toEqual(
        [],
      );
    }
  });

  it("derives the next friendly label instead of trusting a stored session counter", () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          activeTabId: "code",
          closedTabs: [{ id: "old", label: "Code 8", tmuxSession: "code-old" }],
          nextTabIndex: Number.MAX_SAFE_INTEGER,
          tabs: [{ id: "code", label: "Code", tmuxSession: "code" }],
        }),
    } as Pick<Storage, "getItem">;

    expect(loadStoredTerminalState("terminal", storage).nextTabLabelIndex).toBe(
      9,
    );
  });

  it("bounds wrapped URL continuation work", () => {
    const lines = Array.from({ length: 100 }, () =>
      createFakeTerminalLine(createAsciiCells("abcd"), true),
    );
    const terminal = createFakeTerminal(lines);

    const result = collectTerminalUrl(terminal, 0, 0, "http");
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected a terminal URL candidate");

    expect(result.range.end.y).toBe(WEB_LINK_MAX_CONTINUATION_LINES + 1);
    expect(result.text).toHaveLength(4 * (WEB_LINK_MAX_CONTINUATION_LINES + 1));
  });

  it("stops URL continuation when xterm says the next line is not wrapped", () => {
    const lines = [
      createFakeTerminalLine(createAsciiCells("http")),
      createFakeTerminalLine(createAsciiCells("example.com")),
    ];
    const terminal = createFakeTerminal(lines);
    const result = collectTerminalUrl(terminal, 0, 0, "http");
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected a terminal URL candidate");

    expect(result.text).toBe("http");
  });

  it("maps JavaScript string indexes to xterm columns after a wide character", () => {
    const url = "https://example.com";
    const cells = [
      { characters: "界", width: 2 },
      { characters: "", width: 0 },
      ...createAsciiCells(url),
    ];
    const terminal = createFakeTerminal([createFakeTerminalLine(cells)]);
    const container = createFakeTerminalContainer(cells.length);
    let providedLinks: import("@xterm/xterm").ILink[] | undefined;

    createWrappedUrlLinkProvider(terminal).provideLinks(1, (links) => {
      providedLinks = links;
    });

    expect(providedLinks?.[0]?.range).toEqual({
      start: { x: 3, y: 1 },
      end: { x: cells.length, y: 1 },
    });
    expect(getTerminalUrlAtPoint(terminal, container, 15, 5)).toBeNull();
    expect(
      getTerminalUrlAtPoint(terminal, container, cells.length * 10 - 5, 5),
    ).toBe(url);
  });

  it("keeps link ranges aligned across untouched blank cells", () => {
    const url = "https://example.com";
    const cells = [
      ...createAsciiCells("docs"),
      ...Array.from({ length: 4 }, () => ({ characters: "", width: 1 })),
      ...createAsciiCells(url),
    ];
    const terminal = createFakeTerminal([createFakeTerminalLine(cells)]);
    const container = createFakeTerminalContainer(cells.length);
    let providedLinks: import("@xterm/xterm").ILink[] | undefined;

    createWrappedUrlLinkProvider(terminal).provideLinks(1, (links) => {
      providedLinks = links;
    });

    expect(providedLinks?.[0]?.range).toEqual({
      start: { x: 9, y: 1 },
      end: { x: cells.length, y: 1 },
    });
    expect(getTerminalUrlAtPoint(terminal, container, 75, 5)).toBeNull();
    expect(getTerminalUrlAtPoint(terminal, container, 85, 5)).toBe(url);
  });

  it("includes every display cell when a URL contains wide characters", () => {
    const urlPrefix = "https://example.com/";
    const url = `${urlPrefix}日本語`;
    const cells = [
      ...createAsciiCells(urlPrefix),
      { characters: "日", width: 2 },
      { characters: "", width: 0 },
      { characters: "本", width: 2 },
      { characters: "", width: 0 },
      { characters: "語", width: 2 },
      { characters: "", width: 0 },
    ];
    const terminal = createFakeTerminal([createFakeTerminalLine(cells)]);
    const container = createFakeTerminalContainer(cells.length);
    let providedLinks: import("@xterm/xterm").ILink[] | undefined;

    createWrappedUrlLinkProvider(terminal).provideLinks(1, (links) => {
      providedLinks = links;
    });

    expect(providedLinks?.[0]?.range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: cells.length, y: 1 },
    });
    expect(
      getTerminalUrlAtPoint(terminal, container, cells.length * 10 - 5, 5),
    ).toBe(url);
  });

  it("opens only normalized HTTP and HTTPS destinations", () => {
    const open = vi.fn(() => null);
    const windowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { open },
    });

    try {
      for (const rejected of [
        "javascript:alert(1)",
        "data:text/plain,hello",
        "file:///etc/passwd",
        "not a URL",
      ]) {
        openTerminalUrl(rejected);
      }
      expect(open).not.toHaveBeenCalled();

      openTerminalUrl("https://example.com/\u0000safe");
      expect(open).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith(
        "https://example.com/safe",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      if (windowDescriptor) {
        Object.defineProperty(globalThis, "window", windowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });
});

describe("terminal scrolling", () => {
  it("uses one-fifth wheel speed and restores normal speed with fast scroll", () => {
    expect(TERMINAL_SCROLL_OPTIONS).toEqual({
      scrollSensitivity: 0.2,
      fastScrollSensitivity: 5,
    });
    expect(
      TERMINAL_SCROLL_OPTIONS.scrollSensitivity *
        TERMINAL_SCROLL_OPTIONS.fastScrollSensitivity,
    ).toBe(1);
  });

  it("keeps vertical wheel input with xterm and horizontal input with the pan view", () => {
    expect(getDominantScrollAxis(0, 24)).toBe("vertical");
    expect(getDominantScrollAxis(24, 0)).toBe("horizontal");
    expect(getDominantScrollAxis(0, 0)).toBeNull();
  });
});

describe("terminal text selection", () => {
  it("creates a forward selection across terminal rows", () => {
    expect(
      getTerminalSelectionRange(
        { column: 5, row: 10 },
        { column: 3, row: 11 },
        80,
      ),
    ).toEqual({ column: 5, row: 10, length: 79 });
  });

  it("normalizes a backwards drag", () => {
    expect(
      getTerminalSelectionRange(
        { column: 3, row: 11 },
        { column: 5, row: 10 },
        80,
      ),
    ).toEqual({ column: 5, row: 10, length: 79 });
  });
});

describe("terminal input editing", () => {
  it("sends only appended text", () => {
    expect(buildInputEditSequence("cod", "code", 4)).toBe("e");
  });

  it("uses terminal backspace when text is removed", () => {
    expect(buildInputEditSequence("code", "cod", 3)).toBe("\x7f");
  });

  it("clears and replaces the live line for middle edits", () => {
    expect(buildInputEditSequence("code", "cope", 2)).toBe("\x15cope");
  });
});
