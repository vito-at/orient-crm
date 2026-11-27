-- Дубли документов с сайта (аудит 4.14): один и тот же документ сайта мог сохраниться в заявке дважды,
-- когда загрузку одновременно запускали приложение и воркер. Оставляем одну копию: уже подтверждённую сайту,
-- иначе самую раннюю. Содержимое копий одинаковое (тот же файл сайта).
DELETE FROM "LeadDocument" d
USING (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "serviceId", "externalId"
    ORDER BY ("siteAckAt" IS NULL), "createdAt", "id"
  ) AS rn
  FROM "LeadDocument"
  WHERE "externalId" IS NOT NULL
) x
WHERE d."id" = x."id" AND x.rn > 1;

-- CreateIndex
CREATE UNIQUE INDEX "LeadDocument_serviceId_externalId_key" ON "LeadDocument"("serviceId", "externalId");
