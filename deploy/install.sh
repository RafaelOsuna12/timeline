#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Instalacion inicial de estadisticas.honorlab.dev en un servidor Ubuntu/Debian.
#
# Ejecutar como root (o con sudo) UNA sola vez:
#     sudo bash deploy/install.sh
#
# Deja el sistema corriendo en http://127.0.0.1:4000 detras de nginx.
# El certificado TLS se emite despues con deploy/setup-ssl.sh.
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${DOMAIN:-estadisticas.honorlab.dev}"
APP_DIR="${APP_DIR:-/opt/estadisticas}"
DATA_DIR="${DATA_DIR:-/var/lib/estadisticas}"
APP_USER="${APP_USER:-estadisticas}"
NODE_MAJOR="${NODE_MAJOR:-20}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecuta este script con sudo."

log "Instalando dependencias del sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git nginx ufw python3 build-essential

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]]; then
  log "Instalando Node.js ${NODE_MAJOR}.x"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
log "Node.js $(node -v)"

log "Creando el usuario de servicio '${APP_USER}'"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

log "Preparando directorios"
mkdir -p "$APP_DIR" "$DATA_DIR/uploads" /var/www/certbot
if [[ "$REPO_DIR" != "$APP_DIR" ]]; then
  # rsync no siempre esta instalado: se usa tar, que si lo esta.
  tar -C "$REPO_DIR" --exclude='.git' --exclude='node_modules' --exclude='server/data' -cf - . |
    tar -C "$APP_DIR" -xf -
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

log "Instalando dependencias de la aplicacion"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR/server' && npm ci --omit=dev"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR/web' && npm ci && npm run build"

if [[ ! -f "$APP_DIR/server/.env" ]]; then
  log "Generando la configuracion inicial (.env)"
  JWT_SECRET="$(openssl rand -hex 48)"
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)"
  cat > "$APP_DIR/server/.env" <<ENVEOF
NODE_ENV=production
HOST=127.0.0.1
PORT=4000
TRUST_PROXY=true
PUBLIC_URL=https://${DOMAIN}

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=12h

DATA_DIR=${DATA_DIR}
KEEP_SOURCE_FILES=true
MAX_UPLOAD_MB=80

ADMIN_USERNAME=admin
ADMIN_NAME=Administrador
ADMIN_PASSWORD=${ADMIN_PASSWORD}
ENVEOF
  chown "$APP_USER:$APP_USER" "$APP_DIR/server/.env"
  chmod 600 "$APP_DIR/server/.env"
  CREATED_PASSWORD="$ADMIN_PASSWORD"
else
  log "Se conserva el archivo .env existente"
  CREATED_PASSWORD=""
fi

log "Instalando el servicio de systemd"
sed "s#/opt/estadisticas#${APP_DIR}#g; s#/var/lib/estadisticas#${DATA_DIR}#g; s#User=estadisticas#User=${APP_USER}#; s#Group=estadisticas#Group=${APP_USER}#" \
  "$APP_DIR/deploy/systemd/estadisticas.service" > /etc/systemd/system/estadisticas.service
systemctl daemon-reload
systemctl enable --now estadisticas

log "Configurando nginx"
sed "s/estadisticas\.honorlab\.dev/${DOMAIN}/g" \
  "$APP_DIR/deploy/nginx/estadisticas.honorlab.dev.conf" > "/etc/nginx/sites-available/${DOMAIN}"
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
rm -f /etc/nginx/sites-enabled/default

# Antes de tener certificado, nginx no arranca con el bloque 443: se deja
# temporalmente solo el bloque 80 hasta que certbot emita el certificado.
if [[ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
  log "Aun no hay certificado: se habilita solo HTTP mientras tanto"
  cat > "/etc/nginx/sites-available/${DOMAIN}" <<HTTPEOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}
HTTPEOF
fi

nginx -t
systemctl reload nginx

log "Configurando el firewall"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

cat <<FIN

--------------------------------------------------------------------------
Instalacion completada.

  Servicio:  systemctl status estadisticas
  Registros: journalctl -u estadisticas -f
  Datos:     ${DATA_DIR}

Siguiente paso — emitir el certificado TLS:

  sudo bash ${APP_DIR}/deploy/setup-ssl.sh

Antes de ejecutarlo, confirma que el dominio ${DOMAIN} apunta con un
registro A (y AAAA si usas IPv6) a la IP publica de este servidor.
FIN

if [[ -n "$CREATED_PASSWORD" ]]; then
  cat <<CRED

  Usuario administrador inicial
    usuario:    admin
    contrasena: ${CREATED_PASSWORD}

  Cambiala desde Administracion la primera vez que entres.
  Tambien queda guardada en ${APP_DIR}/server/.env (permisos 600).
CRED
fi
echo "--------------------------------------------------------------------------"
