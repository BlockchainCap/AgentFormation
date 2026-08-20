import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTab, parseTabs } from "./tabs";

beforeEach(() => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000000",
  );
});

describe("terminal tabs", () => {
  it("discards unsafe tmux session names", () => {
    const tabs = parseTabs(
      JSON.stringify([
        { id: "bad", label: "Bad", tmuxSession: "x; id" },
        { id: "good", label: "Good", tmuxSession: "code_2" },
      ]),
    );
    expect(tabs).toEqual([
      { id: "good", label: "Good", tmuxSession: "code_2" },
    ]);
  });

  it("caps the workspace at six tabs", () => {
    const tabs = Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      label: `Terminal ${index + 1}`,
      tmuxSession: `code-${index + 1}`,
    }));
    expect(nextTab(tabs)).toBeUndefined();
  });
});
