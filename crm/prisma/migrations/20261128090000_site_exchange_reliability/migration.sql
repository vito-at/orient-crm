-- Только новые необязательные колонки: существующие данные не меняются (аудит 4.4, 4.5, 4.6)

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN "workerSeenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LeadService" ADD COLUMN "siteFetchNextAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SiteEvent" ADD COLUMN "stuckAt" TIMESTAMP(3);
