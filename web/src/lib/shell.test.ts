import { describe, expect, it } from "vitest";
import { shellQuote } from "./shell";

describe("shellQuote", () => {
  it("quotes spaces and apostrophes without allowing another shell command", () => {
    expect(shellQuote("a file'; touch /tmp/nope")).toBe(
      "'a file'\\''; touch /tmp/nope'",
    );
  });
});
