#!/usr/bin/env bash
#
# Instalador de PushFlow para Ubuntu 22.04 / 24.04.
#
#   sudo bash scripts/install-ubuntu.sh --domain push.tudominio.com --email tu@correo.com
#
# Instala Node.js 22, PostgreSQL 16, Nginx y Certbot; crea la base de datos,
# el usuario del sistema, los servicios systemd y el certificado TLS.
set -euo pipefail

DOMAIN=""
EMAIL=""
INSTALL_DIR="/opt/pushflow"
DB_NAME="pushflow"
DB_USER="pushflow"
SKIP_TLS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --skip-tls) SKIP_TLS=true; shift ;;
    *) echo "Opción desconocida: $1"; exit 1 ;;
  esac
done

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecuta el instalador como root (sudo)."
[[ -n "$DOMAIN" ]] || die "Falta --domain (por ejemplo: push.tudominio.com)."
if [[ "$SKIP_TLS" == false && -z "$EMAIL" ]]; then
  die "Falta --email para el certificado TLS (o usa --skip-tls)."
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
log "Instalando paquetes del sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release ufw ripgrep >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  log "Instalando Node.js 22 LTS"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq && apt-get install -y -qq nodejs
fi
log "Node.js $(node -v)"

if ! command -v psql >/dev/null; then
  log "Instalando PostgreSQL 16"
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y -qq postgresql-16 postgresql-client-16
fi
systemctl enable --now postgresql
log "PostgreSQL $(sudo -u postgres psql -tAc 'SHOW server_version;' | tr -d ' ')"

apt-get install -y -qq nginx
[[ "$SKIP_TLS" == false ]] && apt-get install -y -qq certbot python3-certbot-nginx

# ---------------------------------------------------------------------------
log "Creando usuario del sistema y directorio de la aplicación"
id -u pushflow &>/dev/null || useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin pushflow

mkdir -p "$INSTALL_DIR"
if [[ "$SOURCE_DIR" != "$INSTALL_DIR" ]]; then
  cp -r "$SOURCE_DIR"/{src,migrations,public,scripts,package.json,package-lock.json} "$INSTALL_DIR"/ 2>/dev/null || \
  cp -r "$SOURCE_DIR"/{src,migrations,public,scripts,package.json} "$INSTALL_DIR"/
fi
mkdir -p "$INSTALL_DIR/data/exports"

# ---------------------------------------------------------------------------
log "Configurando la base de datos"
DB_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD';"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -qc "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

# Ajustes razonables para un VPS pequeño (se aplican solo si no existen ya).
PG_CONF="/etc/postgresql/16/main/conf.d/pushflow.conf"
if [[ ! -f "$PG_CONF" ]]; then
  TOTAL_MB=$(free -m | awk '/^Mem:/{print $2}')
  cat > "$PG_CONF" <<PGEOF
# Ajustes aplicados por el instalador de PushFlow
shared_buffers = $((TOTAL_MB / 4))MB
effective_cache_size = $((TOTAL_MB / 2))MB
work_mem = 8MB
maintenance_work_mem = 128MB
max_connections = 100
random_page_cost = 1.1          # SSD
synchronous_commit = off        # la analítica tolera perder el último instante
PGEOF
  systemctl restart postgresql
fi

# ---------------------------------------------------------------------------
log "Escribiendo la configuración"
APP_SECRET="$(openssl rand -base64 48)"
if [[ -f "$INSTALL_DIR/.env" ]]; then
  warn "Ya existe .env: se conserva el actual."
else
  cat > "$INSTALL_DIR/.env" <<ENVEOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
PUBLIC_URL=https://$DOMAIN

DATABASE_URL=postgres://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME
PG_POOL_MAX=12

APP_SECRET=$APP_SECRET
SESSION_TTL_HOURS=720
API_RATE_LIMIT=600
PUBLIC_RATE_LIMIT=120
TRUST_PROXY=true
CORS_ORIGINS=*

WORKER_CONCURRENCY=4
WORKER_BATCH_SIZE=500
SEND_CONCURRENCY=50
WORKER_INLINE=false

VAPID_SUBJECT=mailto:${EMAIL:-admin@$DOMAIN}
RETENTION_EVENTS_MONTHS=13
LOG_LEVEL=info
ENVEOF
  chmod 600 "$INSTALL_DIR/.env"
fi

log "Instalando dependencias de Node"
cd "$INSTALL_DIR"
npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund
chown -R pushflow:pushflow "$INSTALL_DIR"

log "Aplicando migraciones"
sudo -u pushflow env "PATH=$PATH" node src/db/migrate.js up

# ---------------------------------------------------------------------------
log "Instalando los servicios systemd"
cat > /etc/systemd/system/pushflow.service <<SVCEOF
[Unit]
Description=PushFlow — servidor de notificaciones push
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=pushflow
Group=pushflow
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pushflow

# Aislamiento
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/data
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
SVCEOF

cat > /etc/systemd/system/pushflow-worker.service <<WRKEOF
[Unit]
Description=PushFlow — worker de envío
After=network.target postgresql.service pushflow.service
Requires=postgresql.service

[Service]
Type=simple
User=pushflow
Group=pushflow
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node src/workers/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pushflow-worker

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/data
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
WRKEOF

systemctl daemon-reload
systemctl enable --now pushflow pushflow-worker

# ---------------------------------------------------------------------------
log "Configurando Nginx"
cat > /etc/nginx/sites-available/pushflow <<NGXEOF
# Caché del SDK: se sirve mucho y cambia poco.
proxy_cache_path /var/cache/nginx/pushflow levels=1:2 keys_zone=pushflow_sdk:10m
                 max_size=100m inactive=24h use_temp_path=off;

limit_req_zone \$binary_remote_addr zone=pushflow_public:10m rate=30r/s;

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 4m;
    gzip on;
    gzip_types application/javascript application/json text/css text/plain;
    gzip_min_length 512;

    # El SDK y el service worker: cacheables y accesibles desde cualquier origen.
    location /sdk/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_cache pushflow_sdk;
        proxy_cache_valid 200 1h;
        add_header Access-Control-Allow-Origin "*" always;
        add_header X-Cache-Status \$upstream_cache_status;
        include /etc/nginx/proxy_params;
    }

    location = /pushflow-sw.js {
        proxy_pass http://127.0.0.1:3000;
        add_header Service-Worker-Allowed "/" always;
        add_header Cache-Control "no-cache" always;
        include /etc/nginx/proxy_params;
    }

    # Endpoints públicos del SDK: con límite de peticiones por IP.
    location ~ ^/(api/v1/events|api/v1/click|sdk/v1/) {
        limit_req zone=pushflow_public burst=60 nodelay;
        proxy_pass http://127.0.0.1:3000;
        include /etc/nginx/proxy_params;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        include /etc/nginx/proxy_params;
    }
}
NGXEOF

# proxy_params ya trae Host, X-Real-IP y X-Forwarded-For en Ubuntu.
grep -q "X-Forwarded-Proto" /etc/nginx/proxy_params 2>/dev/null || \
  echo 'proxy_set_header X-Forwarded-Proto $scheme;' >> /etc/nginx/proxy_params

mkdir -p /var/cache/nginx/pushflow
ln -sf /etc/nginx/sites-available/pushflow /etc/nginx/sites-enabled/pushflow
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ---------------------------------------------------------------------------
if [[ "$SKIP_TLS" == false ]]; then
  log "Solicitando el certificado TLS (Let's Encrypt)"
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
    log "HTTPS activo. La renovación es automática."
  else
    warn "No se pudo emitir el certificado. Revisa que el DNS de $DOMAIN apunte a este servidor"
    warn "y vuelve a ejecutar:  certbot --nginx -d $DOMAIN"
  fi
fi

log "Configurando el cortafuegos"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
log "Creando el usuario administrador"
ADMIN_EMAIL="${EMAIL:-admin@$DOMAIN}"
ADMIN_PASSWORD="$(openssl rand -base64 12 | tr -d '/+=' | head -c 14)"
sudo -u pushflow env "PATH=$PATH" node scripts/create-admin.js \
  --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" --org "PushFlow" || \
  warn "El usuario administrador ya existía."

cat <<FINAL

────────────────────────────────────────────────────────────────
  PushFlow instalado

  Panel:      https://$DOMAIN
  Usuario:    $ADMIN_EMAIL
  Contraseña: $ADMIN_PASSWORD

  Guarda esta contraseña: no se volverá a mostrar.

  Servicios:  systemctl status pushflow pushflow-worker
  Registros:  journalctl -u pushflow -f
  Config:     $INSTALL_DIR/.env

  Siguiente paso: entra en el panel, crea tu aplicación y copia
  el código de instalación en tu web o en tu APK.
────────────────────────────────────────────────────────────────

FINAL
