import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TotpSetup } from "@/components/account/totp-setup";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { getI18n } from "@/i18n/server";

/** Личный кабинет сотрудника: безопасность входа (двухфакторный вход) */
export default async function AccountPage() {
  const user = await requireUser({ without2fa: true });
  const { t } = await getI18n();
  const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { totpEnabledAt: true } });
  return (
    <div className="max-w-2xl">
      <PageHeader title={t("account.title")} description={`${user.name} · ${user.login}`} />
      <Card>
        <CardHeader>
          <CardTitle>{t("account.totpTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">{t("account.totpAbout")}</p>
          {!u.totpEnabledAt && user.role === "VISA" && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">{t("account.totpRequiredVisa")}</p>
          )}
          <TotpSetup enabledAt={u.totpEnabledAt ? formatDate(u.totpEnabledAt) : null} canDisable={user.role !== "VISA"} />
        </CardContent>
      </Card>
    </div>
  );
}
