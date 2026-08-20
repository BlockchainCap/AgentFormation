import { redirect } from "next/navigation";
import { LogOut, ShieldCheck, TerminalSquare } from "lucide-react";
import { TerminalWorkspace } from "@/components/terminal/terminal-workspace";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { cachedAuth, signIn, signOut } from "@/lib/auth";
import { getRuntimeForSubject } from "@/lib/registry";
import { isActiveRuntime } from "@/lib/runtime-access";

function SignInPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-8 rounded-2xl border bg-card p-8 shadow-xl">
        <div className="space-y-4 text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-400">
            <TerminalSquare className="size-7" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              AgentFormation
            </h1>
            <p className="text-sm text-muted-foreground">
              Persistent remote coding agents, inside your AWS account.
            </p>
          </div>
        </div>
        <form
          action={async () => {
            "use server";
            await signIn("cognito", { redirectTo: "/" });
          }}
        >
          <Button type="submit" size="lg" className="w-full gap-2">
            <ShieldCheck className="size-4" /> Sign in
          </Button>
        </form>
        <p className="text-center text-xs text-muted-foreground">
          Access is limited to users invited by this deployment&apos;s
          administrator.
        </p>
      </div>
    </main>
  );
}

export default async function Home() {
  const session = await cachedAuth();
  if (!session?.user?.id) return <SignInPage />;

  const runtime = await getRuntimeForSubject(session.user.id);
  if (!isActiveRuntime(runtime)) redirect("/auth-error?error=AccessDenied");

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 items-center justify-between border-b bg-card px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">AgentFormation</p>
          <p className="truncate text-xs text-muted-foreground">
            {session.user.email} · /workspace
          </p>
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <Button
              type="submit"
              variant="ghost"
              size="icon-sm"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="size-4" />
            </Button>
          </form>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <TerminalWorkspace storageScope={session.user.id} />
      </main>
    </div>
  );
}
