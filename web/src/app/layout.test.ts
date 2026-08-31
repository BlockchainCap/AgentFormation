import { describe, expect, it } from "vitest";
import { viewport } from "./layout";

describe("mobile viewport", () => {
  it("keeps the terminal at device scale like the main release", () => {
    expect(viewport).toMatchObject({
      maximumScale: 1,
      userScalable: false,
    });
  });
});
