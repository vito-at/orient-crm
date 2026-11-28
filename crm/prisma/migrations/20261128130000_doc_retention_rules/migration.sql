-- Сроки хранения документов (решение владельца 28.11.2026): туры, авиабилеты и прочие услуги — через 30 дней после
-- возвращения клиента, брошенные заявки и файлы из переписки — через 90 дней без движения. Только новые колонки с
-- значениями по умолчанию: существующие данные не меняются.

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "idleDocRetentionDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "tripDocRetentionDays" INTEGER NOT NULL DEFAULT 30;
