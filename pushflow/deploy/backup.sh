#!/usr/bin/env bash
# Copia de seguridad diaria de la base de datos de PushFlow.
# Programar con:  0 3 * * * /opt/pushflow/deploy/backup.sh
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/pushflow}"
KEEP_DAYS="${KEEP_DAYS:-14}"
ENV_FILE="${ENV_FILE:-/opt/pushflow/.env}"

[[ -f "$ENV_FILE" ]] || { echo "No se encuentra $ENV_FILE"; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/pushflow-$(date +%Y%m%d-%H%M%S).sql.gz"

# Los eventos crudos son voluminosos y reconstruibles: se pueden excluir con
# EXCLUDE_EVENTS=1 para que la copia sea mucho más pequeña.
EXCLUDE=()
[[ "${EXCLUDE_EVENTS:-0}" == "1" ]] && EXCLUDE=(--exclude-table-data='events*' --exclude-table-data='deliveries*')

pg_dump "$DATABASE_URL" --no-owner --no-acl "${EXCLUDE[@]}" | gzip -9 > "$FILE"
echo "Copia creada: $FILE ($(du -h "$FILE" | cut -f1))"

find "$BACKUP_DIR" -name 'pushflow-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
echo "Copias anteriores a $KEEP_DAYS días eliminadas."
