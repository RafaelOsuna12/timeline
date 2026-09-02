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

log "Reiniciando el servicio"
systemctl restart estadisticas
sleep 3

if curl -fsS --max-time 10 http://127.0.0.1:4000/api/health >/dev/null; then
  log "Listo: el servicio responde correctamente."
  systemctl --no-pager --lines=0 status estadisticas || true
else
  die "El servicio no responde. Revisa: journalctl -u estadisticas -n 60"
fi
