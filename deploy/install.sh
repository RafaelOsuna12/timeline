#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Instalacion inicial de estadisticas.honorlab.dev en un servidor Ubuntu/Debian.
#
# Ejecutar como root (o con sudo) UNA sola vez:
#     sudo bash deploy/install.sh
#
# Deja el sistema corriendo en 127.0.0.1 detras de nginx. Si el puerto 4000
# esta ocupado, se elige automaticamente el siguiente libre.
# El certificado TLS se emite despues con deploy/setup-ssl.sh.
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${DOMAIN:-estadisticas.honorlab.dev}"
APP_DIR="${APP_DIR:-/opt/estadisticas}"
DATA_DIR="${DATA_DIR:-/var/lib/estadisticas}"
APP_USER="${APP_USER:-estadisticas}"
NODE_MAJOR="${NODE_MAJOR:-20}"
APP_PORT="${APP_PORT:-4000}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# nginx cambio la sintaxis de HTTP/2 en la version 1.25.1: antes se activaba
# con "http2" en la linea listen y despues con la directiva "http2 on;".
# El archivo del repositorio usa la forma nueva; esta funcion lo convierte a la
# antigua cuando el servidor tiene una version anterior, para que la misma
# configuracion sirva en cualquier Ubuntu o Debian.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# El puerto del backend puede estar ocupado por otro servicio del servidor
# (es habitual con contenedores de Docker publicando puertos altos). En vez de
# fallar al arrancar, se busca el siguiente puerto libre.
# ---------------------------------------------------------------------------
port_in_use() {
  # Se prueba conectando: no depende de que ss o lsof esten instalados, y mide
  # exactamente lo que importa, que es si 127.0.0.1:<puerto> ya esta atendido.
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

find_free_port() {
  local candidate="$1"
  local limit=$(( candidate + 50 ))
  while (( candidate < limit )) && port_in_use "$candidate"; do
    candidate=$(( candidate + 1 ))
  done
  port_in_use "$candidate" && die "No se encontro un puerto libre a partir de $1."
  printf '%s' "$candidate"
}

adapt_http2_syntax() {
  local file="$1"
  local version newest
  version="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9][0-9.]*\).*#\1#p')"
  [[ -n "$version" ]] || return 0
  newest="$(printf '%s\n%s\n' "$version" "1.25.1" | sort -V | tail -1)"
  [[ "$newest" == "$version" ]] && return 0   # 1.25.1 o superior: nada que cambiar

  sed -i \
    -e 's/^\([[:space:]]*\)http2 on;/\1# HTTP\/2 se activa en la linea listen (nginx < 1.25.1)/' \
    -e 's/^\([[:space:]]*\)listen 443 ssl;/\1listen 443 ssl http2;/' \
    -e 's/^\([[:space:]]*\)listen \[::\]:443 ssl;/\1listen [::]:443 ssl http2;/' \
    "$file"
}

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

# El repositorio queda a nombre del usuario de servicio, asi que git se negaria
# a operar sobre el como root ("dubious ownership"). Se registra la excepcion
# para que `sudo git pull` funcione en las actualizaciones.
if [[ -d "$APP_DIR/.git" ]]; then
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  sudo -u "$APP_USER" git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
fi

log "Instalando dependencias de la aplicacion"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR/server' && npm ci --omit=dev"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR/web' && npm ci && npm run build"

if [[ -f "$APP_DIR/server/.env" ]]; then
  # Se respeta el puerto ya configurado para no romper una instalacion en uso.
  APP_PORT="$(sed -n 's/^PORT=\([0-9]\+\).*/\1/p' "$APP_DIR/server/.env" | head -1)"
  APP_PORT="${APP_PORT:-4000}"
else
  APP_PORT="$(find_free_port "$APP_PORT")"
  [[ "$APP_PORT" == "4000" ]] || log "El puerto 4000 esta ocupado: se usara el $APP_PORT"
fi

if [[ ! -f "$APP_DIR/server/.env" ]]; then
  log "Generando la configuracion inicial (.env)"
  JWT_SECRET="$(openssl rand -hex 48)"
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)"
  cat > "$APP_DIR/server/.env" <<ENVEOF
NODE_ENV=production
HOST=127.0.0.1
PORT=${APP_PORT}
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
systemctl enable estadisticas >/dev/null
systemctl restart estadisticas

# Arrancar el servicio no basta: si el puerto esta ocupado o falta una
# dependencia, systemd lo reinicia en bucle y la instalacion parecia correcta.
log "Comprobando que el servicio responda"
service_ok=false
for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
    service_ok=true
    break
  fi
  sleep 1
done
if [[ "$service_ok" != true ]]; then
  echo
  journalctl -u estadisticas -n 25 --no-pager || true
  die "El servicio no responde en el puerto ${APP_PORT}. Revisa el registro de arriba."
fi
log "El servicio responde en 127.0.0.1:${APP_PORT}"

log "Configurando nginx"
sed -e "s/estadisticas\.honorlab\.dev/${DOMAIN}/g" \
    -e "s#127\.0\.0\.1:4000#127.0.0.1:${APP_PORT}#g" \
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

adapt_http2_syntax "/etc/nginx/sites-available/${DOMAIN}"

if ! nginx -t; then
  die "La configuracion de nginx no es valida. Revisa /etc/nginx/sites-available/${DOMAIN}"
fi
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
  Puerto:    127.0.0.1:${APP_PORT} (solo local; nginx lo publica)
FIN

if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
  cat <<FIN

El dominio ya tiene certificado, asi que el sitio esta listo:

  https://${DOMAIN}

No hace falta ejecutar setup-ssl.sh.
FIN
else
  cat <<FIN

Siguiente paso — emitir el certificado TLS:

  sudo bash ${APP_DIR}/deploy/setup-ssl.sh

Antes de ejecutarlo, confirma que el dominio ${DOMAIN} apunta con un
registro A (y AAAA si usas IPv6) a la IP publica de este servidor.
FIN
fi

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
