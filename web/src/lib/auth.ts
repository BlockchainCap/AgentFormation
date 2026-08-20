import { cache } from "react";
import NextAuth from "next-auth";
import Cognito from "next-auth/providers/cognito";
import { z } from "zod";
import { getAuthEnvironment } from "./env";
import { getRuntimeForSubject } from "./registry";
import { isActiveRuntime } from "./runtime-access";

const cognitoProfileSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.literal(true),
});

const authEnvironment = getAuthEnvironment();

const nextAuth = NextAuth({
  providers: [
    Cognito({
      clientId: authEnvironment.clientId,
      clientSecret: authEnvironment.clientSecret,
      issuer: authEnvironment.issuer,
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ profile }) {
      const parsed = cognitoProfileSchema.safeParse(profile);
      if (!parsed.success) {
        return false;
      }

      const runtime = await getRuntimeForSubject(parsed.data.sub);
      return isActiveRuntime(runtime);
    },
    async jwt({ token, profile }) {
      const parsed = cognitoProfileSchema.safeParse(profile);
      if (parsed.success) {
        token.subject = parsed.data.sub;
        token.email = parsed.data.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && typeof token.subject === "string") {
        session.user.id = token.subject;
      }
      return session;
    },
  },
  pages: { error: "/auth-error" },
  secret: authEnvironment.secret,
  trustHost: true,
});

export const { handlers, auth, signIn, signOut } = nextAuth;
export const cachedAuth = cache(auth);
