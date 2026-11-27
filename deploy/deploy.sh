#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Actualiza la aplicacion ya instalada con la ultima version del repositorio.
#
#     sudo bash /opt/estadisticas/deploy/deploy.sh
#
# No toca la base de datos ni los archivos cargados: solo el codigo.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/estadisticas}"
APP_USER="${APP_USER:-estadisticas}"
# Por defecto se actualiza la misma rama con la que se clono el repositorio,
# en vez de asumir un nombre fijo que puede no existir.
BRANCH="${BRANCH:-}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecuta este script con sudo."
[[ -d "$APP_DIR" ]] || die "No existe $APP_DIR. Ejecuta primero deploy/install.sh."

if [[ -d "$APP_DIR/.git" ]]; then
  if [[ -z "$BRANCH" ]]; then
    BRANCH="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    [[ -n "$BRANCH" && "$BRANCH" != "HEAD" ]] || die "No se pudo determinar la rama. Indica una con BRANCH=<rama>."
  fi
  log "Descargando la ultima version (rama ${BRANCH})"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard "origin/${BRANCH}"
else
  echo "  $APP_DIR no es un clon de git: se asume que el codigo ya se copio a mano."
fi

log "Actualizando dependencias del servidor"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR/server' && npm ci --omit=dev"

log "Compilando el frontend"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR/web' && npm ci && npm run build"

# El respaldo diario se programa aqui ademas de en install.sh: las
# instalaciones hechas antes de paqueteria no lo tienen, y ahora hay datos
# capturados a mano que ningun Excel puede reconstruir.
CRON_FILE=/etc/cron.d/estadisticas-backup
if [[ ! -f "$CRON_FILE" ]]; then
  BACKUP_DIR="${BACKUP_DIR:-/var/backups/estadisticas}"
  log "Programando el respaldo diario en ${BACKUP_DIR}"
  mkdir -p "$BACKUP_DIR"
  {
    echo "# Respaldo de la base y de los archivos cargados. Generado por deploy.sh."
    echo "SHELL=/bin/bash"
    echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    echo "17 3 * * * root ${APP_DIR}/deploy/backup.sh ${BACKUP_DIR} >/dev/null 2>&1"
  } > "$CRON_FILE"
  chmod 644 "$CRON_FILE"
fi

log "Reiniciando el servicio"
systemctl restart estadisticas
sleep 3

if curl -fsS --max-time 10 http://127.0.0.1:4000/api/health >/dev/null; then
  log "Listo: el servicio responde correctamente."
  systemctl --no-pager --lines=0 status estadisticas || true
else
  die "El servicio no responde. Revisa: journalctl -u estadisticas -n 60"
fi
