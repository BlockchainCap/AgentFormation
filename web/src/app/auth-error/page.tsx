import { connection } from "next/server";
import { Suspense } from "react";
import { AuthErrorContent } from "./auth-error-content";

export default async function AuthErrorPage() {
  await connection();
  return (
    <Suspense>
      <AuthErrorContent />
    </Suspense>
  );
}
