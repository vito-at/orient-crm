import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    role: "ADMIN" | "MANAGER" | "VISA";
    login: string;
    /** вход был с кодом двухфакторной защиты */
    totp?: boolean;
  }
  interface Session {
    user: { id: string; role: "ADMIN" | "MANAGER" | "VISA"; login: string; totp: boolean } & DefaultSession["user"];
  }
}
