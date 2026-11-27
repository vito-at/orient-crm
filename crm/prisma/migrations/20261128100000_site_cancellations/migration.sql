-- Отмена заявки на сайте (возврат денег, отмена, удаление аккаунта клиентом): работа по визе прекращается.
-- Аудит 27.11.2026, п. 15. Только добавляет необязательные колонки.
ALTER TABLE "LeadService" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "LeadService" ADD COLUMN "cancelReason" TEXT;
