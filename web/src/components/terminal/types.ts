export interface SessionInfo {
  sessionId: string;
  streamUrl: string;
  tokenValue: string;
  terminateToken: string;
}

export interface TerminalTab {
  id: string;
  label: string;
  tmuxSession: string;
}

export type ConnectionState =
  "connecting" | "connected" | "disconnected" | "error";
