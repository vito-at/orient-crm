-- Решение владельца (21.11.2026): у Сабины оклад 2 000 000 сум. Действует с зарплаты за декабрь — её период 21.11–20.12
-- (выплата 20-го), прошлые месяцы не меняются. Процент, надбавка и база процента — как в её текущих условиях.
INSERT INTO "SalaryTerm" ("id", "userId", "fromMonth", "base", "currency", "pct", "bonusPct", "commissionFrom")
SELECT 'st_' || u."id" || '_202612', u."id", DATE '2026-12-01', 2000000, 'UZS',
       COALESCE(t."pct", u."commissionPct"), COALESCE(t."bonusPct", u."planBonusPct"), COALESCE(t."commissionFrom", u."commissionFrom")
FROM "User" u
LEFT JOIN LATERAL (
  SELECT * FROM "SalaryTerm" s WHERE s."userId" = u."id" AND s."fromMonth" <= DATE '2026-12-01' ORDER BY s."fromMonth" DESC LIMIT 1
) t ON TRUE
WHERE u."role" = 'MANAGER' AND (u."name" ILIKE '%сабин%' OR u."name" ILIKE '%sabin%')
ON CONFLICT ("userId", "fromMonth") DO UPDATE SET "base" = 2000000, "currency" = 'UZS';
