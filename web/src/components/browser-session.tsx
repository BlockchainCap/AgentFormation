"use client";

import { SessionProvider } from "next-auth/react";

export function BrowserSession({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider refetchInterval={60 * 60} refetchWhenOffline={false}>
      {children}
    </SessionProvider>
  );
}
