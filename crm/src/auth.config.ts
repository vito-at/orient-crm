import type { NextAuthConfig } from "next-auth";

/** Разделы, доступные визовому специалисту */
const VISA_PATHS = ["/visa", "/countries", "/api/docs", "/api/notifications", "/account"];

// Конфиг без зависимостей от Node (Prisma, bcrypt) — используется в middleware.
export const authConfig = {
  pages: { signIn: "/login" },
  // вход живёт 14 дней с последней активности; смена пароля или 2FA закрывает его раньше (lib/session-stamp.ts)
  session: { strategy: "jwt", maxAge: 14 * 24 * 60 * 60 },
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const isPublic = pathname.startsWith("/login") || pathname.startsWith("/privacy") || pathname.startsWith("/o/") || pathname.startsWith("/api/webhooks") || pathname.startsWith("/api/chats/out/") || pathname.startsWith("/api/public/") || pathname.startsWith("/api/auth");
      if (isPublic) return true;
      if (!auth?.user) return false;
      // визовый специалист и администратор без двухфакторного входа сначала включают его (у них доступ к паспортам клиентов)
      if ((auth.user.role === "VISA" || auth.user.role === "ADMIN") && !auth.user.totp && !pathname.startsWith("/account")) return Response.redirect(new URL("/account", request.nextUrl));
      // визовый специалист работает только в своём кабинете
      if (auth.user.role === "VISA" && !VISA_PATHS.some((p) => pathname.startsWith(p))) return Response.redirect(new URL("/visa", request.nextUrl));
      return true;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id!;
        token.role = user.role;
        token.login = user.login;
        token.totp = !!user.totp;
        token.stamp = user.stamp;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      session.user.role = token.role as "ADMIN" | "MANAGER" | "VISA";
      session.user.login = token.login as string;
      session.user.totp = !!token.totp;
      session.user.stamp = typeof token.stamp === "string" ? token.stamp : undefined;
      return session;
    },
  },
} satisfies NextAuthConfig;
