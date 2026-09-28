import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "./browser-session";

const fetchSession = vi.fn(async () =>
  Response.json({
    user: { id: "11111111-1111-4111-8111-111111111111" },
    expires: "2026-01-31T12:00:00.000Z",
  }),
);

async function mount() {
  await act(async () => {
    render(
      <BrowserSession>
        <p>Terminal stays mounted</p>
      </BrowserSession>,
    );
  });
}

describe("browser login renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchSession);
    fetchSession.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renews through the session endpoint when the app opens", async () => {
    await mount();
    expect(fetchSession).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.any(Object),
    );
    expect(screen.getByText("Terminal stays mounted")).toBeInTheDocument();
  });

  it("renews hourly without remounting the terminal", async () => {
    await mount();
    const terminal = screen.getByText("Terminal stays mounted");
    fetchSession.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
    expect(fetchSession).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.any(Object),
    );
    expect(screen.getByText("Terminal stays mounted")).toBe(terminal);
  });

  it("renews when the browser or mobile app returns to the foreground", async () => {
    await mount();
    fetchSession.mockClear();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchSession).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.any(Object),
    );
  });

  it("pauses periodic renewal while offline and resumes when online", async () => {
    await mount();
    await act(async () => window.dispatchEvent(new Event("offline")));
    fetchSession.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
    expect(fetchSession).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new Event("online")));
    await act(async () => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
    expect(fetchSession).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.any(Object),
    );
  });
});
