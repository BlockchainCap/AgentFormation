import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const template = readFileSync(
  resolve(import.meta.dirname, "../../../templates/foundation.yaml"),
  "utf8",
);
const terminalSessionDocument = template.slice(
  template.indexOf("  TerminalSessionDocument:"),
  template.indexOf("Outputs:"),
);

describe("terminal session document", () => {
  it("enables tmux mouse scrollback before attaching the browser", () => {
    expect(terminalSessionDocument).toContain(
      "tmux set-option -g mouse on \\; set-option -g history-limit 100000 \\; new-session -A",
    );
  });
});
