import { describe, expect, it } from "vitest";
import {
  buildInputEditSequence,
  createTerminalTab,
  getDominantScrollAxis,
  getNextTerminalTabIndex,
  getTerminalSelectionRange,
  normalizeTerminalTabs,
} from "./terminal-shared";

describe("terminal tabs", () => {
  it("normalizes unsafe persisted tmux names before they reach an API", () => {
    expect(
      normalizeTerminalTabs([
        { id: "bad", label: "Bad", tmuxSession: "x; id" },
      ]),
    ).toEqual([{ id: "code", label: "Bad", tmuxSession: "code" }]);
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

  it("continues numbering after restored tabs", () => {
    expect(
      getNextTerminalTabIndex([createTerminalTab(1), createTerminalTab(4)]),
    ).toBe(5);
  });
});

describe("terminal scrolling", () => {
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
