-- Последний рабочий день сотрудника (увольнение): зарплата по этот день, оклад за отработанные дни, после — не начисляется
ALTER TABLE "User" ADD COLUMN "leftAt" DATE;

-- Диора уволилась, последний рабочий день — 19.11.2026 (решение владельца 20.11.2026)
UPDATE "User" SET "leftAt" = DATE '2026-11-19' WHERE "role" = 'MANAGER' AND ("name" ILIKE '%диора%' OR "name" ILIKE '%diora%');
