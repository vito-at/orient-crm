import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { authConfig } from "./auth.config";
import { clientIp, loginBlocked, loginFailed, loginSucceeded } from "@/lib/login-guard";
import { decrypt } from "@/lib/crypto";
import { consumeTotpStep, verifyTotp } from "@/lib/totp";
import { sessionStamp } from "@/lib/session-stamp";

const credentialsSchema = z.object({
  login: z.string().trim().min(1),
  password: z.string().min(1),
  code: z.string().optional(),
});

/** bcrypt-хэш случайной строки — для проверки пароля несуществующего логина за то же время */
const DUMMY_HASH = "$2b$10$r0Lb2b.UOammPnNNBalbL.p49BEK4iq8y6bAwNU.vz5ed2Ez3L9oe";

class InvalidCredentials extends CredentialsSignin {
  code = "invalid_credentials";
}
/** пароль верный, нужен код из приложения-аутентификатора */
class TotpRequired extends CredentialsSignin {
  code = "totp_required";
}
class TotpInvalid extends CredentialsSignin {
  code = "totp_invalid";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  logger: {
    error(error) {
      if (error.name === "CredentialsSignin" || (error as { type?: string }).type === "CredentialsSignin") return;
      console.error("[auth]", error);
    },
  },
  providers: [
    Credentials({
      credentials: { login: {}, password: {}, code: {} },
      async authorize(raw, request) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) throw new InvalidCredentials();
        const login = parsed.data.login.toLowerCase();
        const ip = clientIp(request?.headers);
        // подбор пароля: ограничения по паре «логин + IP», по IP и по логину (lib/login-guard.ts)
        if (loginBlocked(login, ip)) throw new InvalidCredentials();
        const user = await prisma.user.findUnique({ where: { login } });
        // для несуществующего логина тоже проверяем пароль (по фиктивному хэшу): иначе по скорости ответа видно, какие логины есть
        const ok = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);
        if (!user || !user.isActive || !ok) {
          loginFailed(login, ip);
          throw new InvalidCredentials();
        }
        // двухфакторный вход: после верного пароля — код из приложения (один код — один вход)
        if (user.totpEnabledAt && user.totpSecretEnc) {
          const code = parsed.data.code?.trim();
          if (!code) throw new TotpRequired();
          const step = verifyTotp(decrypt(user.totpSecretEnc) ?? "", code);
          if (step === null || !consumeTotpStep(user.id, step)) {
            loginFailed(login, ip);
            throw new TotpInvalid();
          }
        }
        loginSucceeded(login, ip);
        return { id: user.id, name: user.name, role: user.role, login: user.login, totp: !!user.totpEnabledAt, stamp: sessionStamp(user) };
      },
    }),
  ],
});
