"use client";

import { ShieldX } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

export function AuthErrorContent() {
  const params = useSearchParams();
  const error = params.get("error");

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-8">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-destructive/10">
        <ShieldX className="size-8 text-destructive" />
      </div>
      <div className="space-y-2 text-center">
        <h1 className="text-lg font-semibold text-foreground">Access Denied</h1>
        <p className="text-sm text-muted-foreground">
          {error === "AccessDenied"
            ? "Your account does not have an active AgentFormation runtime. Ask this deployment's administrator for access."
            : "Authentication failed. Try again or ask this deployment's administrator for help."}
        </p>
      </div>
      <Button asChild variant="outline">
        <Link href="/">Try Again</Link>
      </Button>
    </div>
  );
}
