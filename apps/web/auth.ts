import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";

declare module "next-auth" {
  interface Session {
    backendJwt?: string;
    backendUserId?: string;
    error?: "BackendAuthFailed";
    user?: DefaultSession["user"] & {
      id?: string;
    };
  }
}

type BackendTokenFields = {
  backendJwt?: string;
  backendUserId?: string;
  backendAuthFailed?: boolean;
};

async function createBackendSession(email: string, name?: string | null) {
  const response = await fetch(`${BACKEND_URL}/user/oauth`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, name }),
  });

  if (!response.ok) {
    throw new Error(`Backend OAuth failed with ${response.status}`);
  }

  return response.json() as Promise<{
    id: string;
    jwt: string;
  }>;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      const backendToken = token as typeof token & BackendTokenFields;

      if (account?.provider !== "google") {
        return backendToken;
      }

      try {
        const email =
          typeof profile?.email === "string"
            ? profile.email
            : typeof backendToken.email === "string"
              ? backendToken.email
              : "";
        const name =
          typeof profile?.name === "string"
            ? profile.name
            : typeof backendToken.name === "string"
              ? backendToken.name
              : null;

        if (!email) {
          backendToken.backendAuthFailed = true;
          return backendToken;
        }

        const backendSession = await createBackendSession(email, name);

        backendToken.backendJwt = backendSession.jwt;
        backendToken.backendUserId = backendSession.id;
        backendToken.backendAuthFailed = false;
      } catch {
        backendToken.backendAuthFailed = true;
      }

      return backendToken;
    },
    async session({ session, token }) {
      const backendToken = token as typeof token & BackendTokenFields;

      session.backendJwt = backendToken.backendJwt;
      session.backendUserId = backendToken.backendUserId;

      if (session.user && backendToken.backendUserId) {
        session.user.id = backendToken.backendUserId;
      }

      if (backendToken.backendAuthFailed) {
        session.error = "BackendAuthFailed";
      }

      return session;
    },
  },
});
