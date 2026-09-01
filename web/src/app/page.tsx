import { redirect } from "next/navigation";
import { ShieldCheck, TerminalSquare } from "lucide-react";
import { EnvironmentSetup } from "@/components/environment-setup";
import { MobileTerminal } from "@/components/mobile-terminal";
import { OAuthCallbackAction } from "@/components/oauth-callback-action";
import { SignOutAction } from "@/components/sign-out-action";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { cachedAuth, signIn, signOut } from "@/lib/auth";
import { getRuntimeForSubject } from "@/lib/registry";
import { isActiveRuntime, isRuntimeAccessRevoked } from "@/lib/runtime-access";

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
              Persistent remote coding agents, inside your company&apos;s AWS
              account.
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
            <ShieldCheck className="size-4" /> Continue with company SSO
          </Button>
        </form>
        <p className="text-center text-xs text-muted-foreground">
          Access is limited to company groups assigned in AWS IAM Identity
          Center. AgentFormation does not keep a separate password.
        </p>
      </div>
    </main>
  );
}

export default async function Home() {
  const session = await cachedAuth();
  if (!session?.user?.id || !session.user.email) return <SignInPage />;

  const runtime = await getRuntimeForSubject(session.user.id);
  if (isRuntimeAccessRevoked(runtime))
    redirect("/auth-error?error=AccessDenied");

  return (
    <div id="agentformation-app-shell" className="flex h-dvh flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-xs font-semibold text-foreground">
            {isActiveRuntime(runtime)
              ? runtime.runtimeStackName
              : "AgentFormation"}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {session.user.email}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {isActiveRuntime(runtime) ? <OAuthCallbackAction /> : null}
          <ThemeToggle />
          <SignOutAction
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          />
        </div>
      </header>
      {isActiveRuntime(runtime) ? (
        <main className="min-h-0 flex-1">
          <MobileTerminal
            storageScope={`${session.user.id}:${runtime.runtimeStackName}`}
          />
        </main>
      ) : (
        <EnvironmentSetup
          initialStatus={runtime?.status ?? "not_created"}
          initialStartedAt={
            runtime?.status === "provisioning"
              ? (runtime.provisioningStartedAt ?? runtime.updatedAt)
              : undefined
          }
        />
      )}
    </div>
  );
}
