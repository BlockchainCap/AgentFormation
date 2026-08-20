import type { TerminalTab } from "./types";

const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_TABS = 6;

export function defaultTab(): TerminalTab {
  return { id: crypto.randomUUID(), label: "Terminal 1", tmuxSession: "code" };
}

export function nextTab(tabs: readonly TerminalTab[]): TerminalTab | undefined {
  if (tabs.length >= MAX_TABS) return undefined;
  const number = tabs.length + 1;
  return {
    id: crypto.randomUUID(),
    label: `Terminal ${number}`,
    tmuxSession: number === 1 ? "code" : `code-${number}`,
  };
}

export function parseTabs(value: string | null): TerminalTab[] {
  if (!value) return [defaultTab()];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [defaultTab()];
    const tabs = parsed
      .filter(
        (tab): tab is TerminalTab =>
          typeof tab === "object" &&
          tab !== null &&
          typeof tab.id === "string" &&
          typeof tab.label === "string" &&
          typeof tab.tmuxSession === "string" &&
          SESSION_PATTERN.test(tab.tmuxSession),
      )
      .slice(0, MAX_TABS);
    return tabs.length > 0 ? tabs : [defaultTab()];
  } catch {
    return [defaultTab()];
  }
}
