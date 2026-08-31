#!/usr/bin/env bash
#
# Actualiza una instalación de PushFlow ya existente.
#
#   cd ~/pushflow-src && git pull
#   sudo bash pushflow/scripts/update.sh
#
# Copia el código nuevo, reinstala dependencias solo si cambiaron, aplica
# migraciones, reinicia los servicios y comprueba que responden. Si el
# servicio no levanta, restaura la versión anterior.
set -euo pipefail

INSTALL_DIR="/opt/pushflow"
SERVICIO_USUARIO="pushflow"
SIN_REINICIO=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --user) SERVICIO_USUARIO="$2"; shift 2 ;;
    --no-restart) SIN_REINICIO=true; shift ;;
    -h|--help)
      echo "Uso: sudo bash scripts/update.sh [--dir /opt/pushflow] [--no-restart]"; exit 0 ;;
    *) echo "Opción desconocida: $1"; exit 1 ;;
  esac
done

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecútalo como root (sudo)."
ORIGEN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -d "$INSTALL_DIR" ]] || die "No existe $INSTALL_DIR. ¿Ejecutaste antes install-ubuntu.sh?"
[[ -f "$INSTALL_DIR/.env" ]] || die "No existe $INSTALL_DIR/.env: la instalación está incompleta."
[[ "$ORIGEN" != "$INSTALL_DIR" ]] || die "El origen y el destino son el mismo directorio."

VERSION_ORIGEN="$(git -C "$ORIGEN" rev-parse --short HEAD 2>/dev/null || echo desconocida)"
log "Actualizando $INSTALL_DIR desde $ORIGEN ($VERSION_ORIGEN)"

# --- Copia de seguridad del código anterior --------------------------------
RESPALDO="/var/backups/pushflow-code-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESPALDO"
for d in src public migrations package.json package-lock.json; do
  [[ -e "$INSTALL_DIR/$d" ]] && cp -a "$INSTALL_DIR/$d" "$RESPALDO/" 2>/dev/null || true
done
ok "Respaldo del código en $RESPALDO"

restaurar() {
  warn "Restaurando la versión anterior desde $RESPALDO"
  for d in src public migrations package.json package-lock.json; do
    [[ -e "$RESPALDO/$d" ]] && { rm -rf "${INSTALL_DIR:?}/$d"; cp -a "$RESPALDO/$d" "$INSTALL_DIR/"; }
  done
  chown -R "$SERVICIO_USUARIO:$SERVICIO_USUARIO" "$INSTALL_DIR"
  systemctl restart pushflow pushflow-worker 2>/dev/null || true
}

# --- Copiar el código nuevo -------------------------------------------------
log "Copiando el código"
# Se borra antes cada carpeta para que los ficheros eliminados en la versión
# nueva no queden como restos: `cp` fusiona, no sincroniza.
for d in src public migrations; do
  rm -rf "${INSTALL_DIR:?}/$d"
  cp -a "$ORIGEN/$d" "$INSTALL_DIR/"
done
cp -a "$ORIGEN/package.json" "$INSTALL_DIR/"
[[ -f "$ORIGEN/package-lock.json" ]] && cp -a "$ORIGEN/package-lock.json" "$INSTALL_DIR/"
[[ -d "$ORIGEN/scripts" ]] && { rm -rf "$INSTALL_DIR/scripts"; cp -a "$ORIGEN/scripts" "$INSTALL_DIR/"; }
ok "Código copiado"

# --- Datos de usuario: nunca se tocan --------------------------------------
mkdir -p "$INSTALL_DIR/data/uploads" "$INSTALL_DIR/data/exports"

# El propietario debe ser el usuario del servicio: se copió como root.
chown -R "$SERVICIO_USUARIO:$SERVICIO_USUARIO" "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/.env"
ok "Permisos ajustados para $SERVICIO_USUARIO"

# --- Dependencias -----------------------------------------------------------
if ! diff -q "$RESPALDO/package.json" "$INSTALL_DIR/package.json" >/dev/null 2>&1; then
  log "package.json cambió: reinstalando dependencias"
  (cd "$INSTALL_DIR" && sudo -u "$SERVICIO_USUARIO" env "PATH=$PATH" \
     npm ci --omit=dev --no-audit --no-fund 2>/dev/null || \
     sudo -u "$SERVICIO_USUARIO" env "PATH=$PATH" npm install --omit=dev --no-audit --no-fund)
  ok "Dependencias al día"
else
  ok "Sin cambios en las dependencias"
fi

# --- Migraciones ------------------------------------------------------------
log "Aplicando migraciones"
(cd "$INSTALL_DIR" && sudo -u "$SERVICIO_USUARIO" env "PATH=$PATH" node src/db/migrate.js up) \
  || { restaurar; die "Las migraciones fallaron. Se restauró la versión anterior."; }

# --- Reinicio y comprobación ------------------------------------------------
if [[ "$SIN_REINICIO" == true ]]; then
  warn "No se reinician los servicios (--no-restart). Hazlo tú:"
  echo "    sudo systemctl restart pushflow pushflow-worker"
  exit 0
fi

log "Reiniciando los servicios"
systemctl restart pushflow pushflow-worker

PUERTO="$(grep -m1 '^PORT=' "$INSTALL_DIR/.env" | cut -d= -f2 | tr -d ' ' || true)"
PUERTO="${PUERTO:-3000}"

for intento in $(seq 1 15); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PUERTO/health" >/dev/null 2>&1; then
    SALUD="$(curl -fsS --max-time 3 "http://127.0.0.1:$PUERTO/health")"
    ok "El servidor responde en el puerto $PUERTO"
    echo "    $SALUD"
    break
  fi
  [[ $intento -eq 15 ]] && {
    warn "El servidor no respondió tras 15 intentos. Últimas líneas del registro:"
    journalctl -u pushflow -n 20 --no-pager | sed 's/^/    /'
    restaurar
    die "Actualización revertida."
  }
  sleep 1
done

systemctl is-active --quiet pushflow-worker && ok "El worker está activo" \
  || warn "El worker NO está activo: revisa 'journalctl -u pushflow-worker -n 30'"

# --- Limpieza de respaldos antiguos ----------------------------------------
ls -1dt /var/backups/pushflow-code-* 2>/dev/null | tail -n +6 | xargs -r rm -rf

cat <<FINAL

────────────────────────────────────────────────────────────────
  PushFlow actualizado a $VERSION_ORIGEN

  Estado:   systemctl status pushflow pushflow-worker
  Registro: journalctl -u pushflow -f
  Respaldo: $RESPALDO

  Si algo falla, para volver atrás:
    sudo cp -a $RESPALDO/* $INSTALL_DIR/
    sudo chown -R $SERVICIO_USUARIO:$SERVICIO_USUARIO $INSTALL_DIR
    sudo systemctl restart pushflow pushflow-worker
────────────────────────────────────────────────────────────────

FINAL
