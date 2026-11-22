"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { loginAction } from "./actions";
import { useI18n } from "@/i18n/client";

export function LoginForm() {
  const { t } = useI18n();
  const [state, action, pending] = useActionState(loginAction, { error: null, login: "" });
  // пароль хранится в форме: при двухфакторном входе его не нужно вводить второй раз вместе с кодом
  const [password, setPassword] = useState("");
  return (
    <form action={action} className="space-y-4">
      <Field label={t("auth.login")}>
        <Input name="login" autoComplete="username" required autoFocus={!state.needCode} defaultValue={state.login} key={state.login} />
      </Field>
      <Field label={t("auth.password")}>
        <Input name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {state.needCode && (
        <Field label={t("auth.code")} hint={t("auth.codeHint")}>
          <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus />
        </Field>
      )}
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t("auth.submitting") : t("auth.submit")}
      </Button>
    </form>
  );
}
