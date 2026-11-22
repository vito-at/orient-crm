"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { confirmTotpAction, disableTotpAction, startTotpSetupAction } from "@/app/(app)/account/actions";
import { useI18n } from "@/i18n/client";

/** Подключение двухфакторного входа: QR-код → код из приложения → вход заново с кодом */
export function TotpSetup({ enabledAt, canDisable }: { enabledAt: string | null; canDisable: boolean }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");

  if (enabledAt)
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
          <ShieldCheck className="size-4" /> {t("account.totpOn", { date: enabledAt })}
        </p>
        {canDisable && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t("auth.code")}>
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="w-32" />
            </Field>
            <Button
              variant="outline"
              disabled={pending || !code.trim()}
              onClick={() =>
                start(async () => {
                  const r = await disableTotpAction(code);
                  if (!r.ok) return void toast.error(r.error);
                  toast.success(t("account.totpOff"));
                  setCode("");
                })
              }
            >
              {t("account.totpDisable")}
            </Button>
          </div>
        )}
      </div>
    );

  if (!setup)
    return (
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await startTotpSetupAction();
            if (!r.ok) return void toast.error(r.error);
            setSetup(r.data ?? null);
          })
        }
      >
        {t("account.totpEnable")}
      </Button>
    );

  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5">
        <li>{t("account.totpStep1")}</li>
        <li>{t("account.totpStep2")}</li>
        <li>{t("account.totpStep3")}</li>
      </ol>
      {/* QR-код: SVG, сгенерированный на сервере библиотекой qrcode */}
      <div className="w-fit rounded-lg border bg-white p-2" dangerouslySetInnerHTML={{ __html: setup.qr }} />
      <p className="text-xs text-muted-foreground">
        {t("account.totpManual")} <span className="select-all font-mono text-foreground">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</span>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("auth.code")}>
          <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="w-32" autoFocus />
        </Field>
        <Button
          disabled={pending || !code.trim()}
          onClick={() =>
            start(async () => {
              const r = await confirmTotpAction(code);
              if (r && !r.ok) toast.error(r.error);
            })
          }
        >
          {t("account.totpConfirm")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("account.totpRelogin")}</p>
    </div>
  );
}
