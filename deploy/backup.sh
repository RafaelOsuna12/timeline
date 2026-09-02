#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Respaldo de la base de datos y de los archivos de Excel originales.
#
#     sudo bash /opt/estadisticas/deploy/backup.sh [directorio-destino]
#
# Para respaldo diario automatico, agregar al cron de root:
#     0 3 * * * /opt/estadisticas/deploy/backup.sh /var/backups/estadisticas
# ---------------------------------------------------------------------------
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/estadisticas}"
DEST="${1:-/var/backups/estadisticas}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DEST"

# La copia de SQLite se hace con .backup para no capturar un estado a medias.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/estadisticas.db" ".backup '$DEST/estadisticas-$STAMP.db'"
else
  # Sin sqlite3 disponible se detiene el servicio unos segundos para copiar.
  systemctl stop estadisticas
  cp "$DATA_DIR/estadisticas.db" "$DEST/estadisticas-$STAMP.db"
  systemctl start estadisticas
fi

tar -C "$DATA_DIR" -czf "$DEST/uploads-$STAMP.tar.gz" uploads

find "$DEST" -name 'estadisticas-*.db' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'uploads-*.tar.gz'  -mtime "+$KEEP_DAYS" -delete

echo "Respaldo creado en $DEST (se conservan $KEEP_DAYS dias)."
