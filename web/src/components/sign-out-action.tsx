"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearStoredTerminalStates } from "@/components/terminal/terminal-shared";

interface SignOutActionProps {
  action: () => Promise<void>;
}

export function SignOutAction({ action }: SignOutActionProps) {
  return (
    <form
      action={action}
      onSubmit={() => {
        try {
          clearStoredTerminalStates(window.localStorage);
        } catch {
          // A locked-down browser can deny storage access. Signing out must
          // still proceed even when there is no readable local state.
        }
      }}
    >
      <Button
        type="submit"
        variant="ghost"
        size="icon-sm"
        aria-label="Sign out"
        title="Sign out"
        className="text-muted-foreground"
      >
        <LogOut className="size-3.5" />
      </Button>
    </form>
  );
}
