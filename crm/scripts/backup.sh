#!/usr/bin/env bash
# Резервная копия базы CRM в /var/backups/orient-crm. В базе всё: лиды, сделки, деньги, переписка и документы
# клиентов (паспорта зашифрованы ключом ENCRYPTION_KEY). Запуск на сервере из папки crm:
#   bash scripts/backup.sh                  — ночная копия (cron), хранится BACKUP_DAYS дней (по умолчанию 7)
#   bash scripts/backup.sh --before-update  — копия перед обновлением (~/orient-deploy.sh), чтобы миграции новой
#                                             версии не шли без свежей копии; хранятся три последние
# Как настроить и как восстановить — README, раздел «Резервные копии и обновление».
# Ключей (.env) в копии НЕТ — храните копию .env отдельно (менеджер паролей, флешка в сейфе): без ENCRYPTION_KEY
# документы из копии не расшифровать, и наоборот — утечка одной копии без .env не раскрывает паспорта.
# Копии на том же сервере не спасут от его потери: BACKUP_RCLONE_REMOTE в .env (хранилище настраивается один раз
# командой rclone config; для паспортных данных — в Узбекистане) — ночная копия уходит ещё и туда.
# Удачная ночная копия отмечается файлом .last-ok.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=${BACKUP_DIR:-/var/backups/orient-crm}
DAYS=${BACKUP_DAYS:-7}
KIND=crm
[ "${1:-}" = "--before-update" ] && KIND=update
STAMP=$(date +%F-%H%M%S)
umask 077
mkdir -p "$DIR"
val() { grep -m1 "^$1=" .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true; }
PGUSER=$(val POSTGRES_USER)
PGDB=$(val POSTGRES_DB)
# недоделанные копии прошлых запусков (сбой посреди копирования)
find "$DIR" -maxdepth 1 -name "*.part" -mmin +180 -delete

# Копия не должна занять весь диск: база, которой некуда писать, останавливается. Нужно вдвое больше прошлой копии
# и ещё 1 ГБ запаса
last=$(ls -1t "$DIR"/*.dump 2>/dev/null | head -1) || true
last_kb=0
[ -n "$last" ] && last_kb=$(du -k "$last" | cut -f1)
free_kb=$(df -Pk "$DIR" | awk 'NR==2{print $4}')
if [ "$free_kb" -lt $((last_kb * 2 + 1048576)) ]; then
  echo "$(date -Is) копия не сделана: на диске свободно $((free_kb / 1024)) МБ, нужно не меньше $(((last_kb * 2 + 1048576) / 1024)) МБ" >&2
  exit 1
fi

# Сначала во временный файл: оборванная копия не выглядит готовой и не вытесняет старые при ротации
docker compose exec -T db pg_dump -U "${PGUSER:-crm}" -Fc "${PGDB:-crm}" >"$DIR/$KIND-$STAMP.dump.part"
# копия — настоящий архив pg_dump, а не пустой файл или текст ошибки (полноту гарантирует код выхода pg_dump)
docker compose exec -T db pg_restore --list <"$DIR/$KIND-$STAMP.dump.part" >/dev/null
mv "$DIR/$KIND-$STAMP.dump.part" "$DIR/$KIND-$STAMP.dump"

if [ "$KIND" = update ]; then
  ls -1t "$DIR"/update-*.dump | tail -n +4 | xargs -r rm -f
  echo "$(date -Is) копия перед обновлением: $DIR/$KIND-$STAMP.dump ($(du -sh "$DIR/$KIND-$STAMP.dump" | cut -f1))"
  exit 0
fi

REMOTE=$(val BACKUP_RCLONE_REMOTE)
if [ -n "$REMOTE" ]; then
  rclone copy "$DIR" "$REMOTE" --include "crm-$STAMP.dump"
  rclone delete "$REMOTE" --min-age "${DAYS}d" --include "crm-*.dump"
fi

find "$DIR" -maxdepth 1 -type f -name "crm-*.dump" -mtime +"$DAYS" -delete
date -Is >"$DIR/.last-ok"
echo "$(date -Is) backup ok: $(du -sh "$DIR/crm-$STAMP.dump" | cut -f1), всего $(du -sh "$DIR" | cut -f1)${REMOTE:+, копия в $REMOTE}"
