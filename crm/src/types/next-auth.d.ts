import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    role: "ADMIN" | "MANAGER" | "VISA";
    login: string;
    /** вход был с кодом двухфакторной защиты */
    totp?: boolean;
    /** отпечаток пароля и 2FA на момент входа (lib/session-stamp.ts) */
    stamp?: string;
  }
  interface Session {
    user: { id: string; role: "ADMIN" | "MANAGER" | "VISA"; login: string; totp: boolean; stamp?: string } & DefaultSession["user"];
  }
}
