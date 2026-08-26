import { cache } from "react";
import NextAuth from "next-auth";
import { z } from "zod";
import { createCognitoProvider } from "./auth-provider";
import { getAuthEnvironment } from "./env";
import { getRuntimeForSubject } from "./registry";

const cognitoProfileSchema = z.object({
  sub: z.string().uuid(),
  email: z
    .string()
    .email()
    .transform((email) => email.toLowerCase()),
});

const authEnvironment = getAuthEnvironment();

const nextAuth = NextAuth({
  providers: [createCognitoProvider(authEnvironment)],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ profile }) {
      const parsed = cognitoProfileSchema.safeParse(profile);
      if (!parsed.success) {
        return false;
      }

      const runtime = await getRuntimeForSubject(parsed.data.sub);
      return runtime?.status !== "disabled";
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
        if (typeof token.email === "string") {
          session.user.email = token.email;
        }
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
