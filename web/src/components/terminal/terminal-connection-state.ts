import type { ConnectMode } from "./terminal-shared";

interface FollowUpConnectOptions {
  connectionId: number;
  currentConnectionId: number;
  fallbackToFreshSession: boolean;
  queuedConnectMode: ConnectMode | null;
}

export function getFollowUpConnectMode({
  connectionId,
  currentConnectionId,
  fallbackToFreshSession,
  queuedConnectMode,
}: FollowUpConnectOptions): ConnectMode | null {
  if (connectionId === currentConnectionId && fallbackToFreshSession) {
    return "start";
  }
  return queuedConnectMode;
}
