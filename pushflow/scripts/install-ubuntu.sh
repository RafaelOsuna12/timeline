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
NGINX_MODE="auto"      # auto | site | snippet | none
APP_PORT="3000"
PORT_EXPLICIT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --port) APP_PORT="$2"; PORT_EXPLICIT=true; shift 2 ;;
    --nginx-mode) NGINX_MODE="$2"; shift 2 ;;
    --existing-tls) SKIP_TLS=true; shift ;;   # el dominio ya tiene certificado
    --skip-tls) SKIP_TLS=true; shift ;;
    -h|--help)
      cat <<'HELP'
Uso: sudo bash scripts/install-ubuntu.sh --domain <dominio> [opciones]

  --domain <d>        Dominio o subdominio donde vivirá PushFlow (obligatorio)
  --email <e>         Correo para Let's Encrypt y para el usuario administrador
  --existing-tls      El dominio YA tiene SSL: no se instala ni ejecuta certbot
  --nginx-mode <m>    auto (por defecto) | site | snippet | none
                        auto    → detecta si ya hay un vhost para el dominio
                        site    → crea un vhost nuevo
                        snippet → genera un fragmento para incluir en tu vhost
                        none    → no toca nginx; solo imprime la configuración
  --port <p>          Puerto interno de la aplicación (por defecto 3000)
  --dir <ruta>        Directorio de instalación (por defecto /opt/pushflow)
HELP
      exit 0 ;;
    *) echo "Opción desconocida: $1 (usa --help)"; exit 1 ;;
  esac
done

case "$NGINX_MODE" in
  auto|site|snippet|none) ;;
  *) echo "--nginx-mode debe ser auto, site, snippet o none"; exit 1 ;;
esac

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecuta el instalador como root (sudo)."
[[ -n "$DOMAIN" ]] || die "Falta --domain (por ejemplo: push.tudominio.com)."
if [[ "$SKIP_TLS" == false && -z "$EMAIL" ]]; then
  die "Falta --email para el certificado TLS (o usa --skip-tls)."
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Si el puerto está ocupado por una instalación previa de PushFlow, no es un
# problema: systemd reiniciará el servicio al final.
if (ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | grep -qE ":$APP_PORT\b"; then
  OWN_PORT=""
  [[ -f "$INSTALL_DIR/.env" ]] && \
    OWN_PORT="$(grep -m1 '^PORT=' "$INSTALL_DIR/.env" | cut -d= -f2 | tr -d ' ' || true)"
  if [[ "$OWN_PORT" == "$APP_PORT" ]]; then
    echo "  El puerto $APP_PORT lo usa la instalación existente de PushFlow: se reutiliza."
  else
    die "El puerto $APP_PORT ya está ocupado por otro servicio. Elige otro con --port <numero>.
     Para ver quién lo usa:  sudo ss -lntp | grep :$APP_PORT"
  fi
fi

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

if [[ "$NGINX_MODE" != "none" ]]; then
  apt-get install -y -qq nginx
  mkdir -p /etc/nginx/snippets /etc/nginx/conf.d
fi
if [[ "$SKIP_TLS" == false && "$NGINX_MODE" != "none" ]]; then
  apt-get install -y -qq certbot python3-certbot-nginx
fi

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

# Si ya hay un .env de una instalación anterior, se reutiliza su contraseña:
# generar una nueva dejaría la base inaccesible para la aplicación.
if [[ -f "$INSTALL_DIR/.env" ]]; then
  EXISTING_URL="$(grep -m1 '^DATABASE_URL=' "$INSTALL_DIR/.env" | cut -d= -f2- || true)"
  DB_PASSWORD="$(printf '%s' "$EXISTING_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p' || true)"
  [[ -n "$DB_PASSWORD" ]] && info_reuse=true
fi
[[ -n "${DB_PASSWORD:-}" ]] || DB_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"

if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  # El rol ya existe: se sincroniza su contraseña con la que usará la aplicación.
  sudo -u postgres psql -qc "ALTER ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD';"
  [[ "${info_reuse:-false}" == true ]] && warn "Rol '$DB_USER' existente: se reutiliza la contraseña del .env" \
                                        || warn "Rol '$DB_USER' existente: se le asigna una contraseña nueva"
else
  sudo -u postgres psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD';"
fi

sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -qc "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

# La aplicación necesita poder crear tablas en el esquema public.
sudo -u postgres psql -q -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO $DB_USER;" 2>/dev/null || true

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

# Si ya hay un .env, su PORT manda salvo que se pida otro con --port:
# de lo contrario nginx apuntaría a un puerto donde no escucha nadie.
if [[ -f "$INSTALL_DIR/.env" ]]; then
  ENV_PORT="$(grep -m1 '^PORT=' "$INSTALL_DIR/.env" | cut -d= -f2 | tr -d ' ' || true)"
  if [[ -n "$ENV_PORT" && "$ENV_PORT" != "$APP_PORT" ]]; then
    if [[ "$PORT_EXPLICIT" == true ]]; then
      warn "Cambiando el puerto de $ENV_PORT a $APP_PORT en el .env existente"
      sed -i "s|^PORT=.*|PORT=$APP_PORT|" "$INSTALL_DIR/.env"
    else
      warn "El .env existente usa el puerto $ENV_PORT: se respeta"
      APP_PORT="$ENV_PORT"
    fi
  fi
fi
APP_SECRET="$(openssl rand -base64 48)"
if [[ -f "$INSTALL_DIR/.env" ]]; then
  warn "Ya existe .env: se conserva el actual."
else
  cat > "$INSTALL_DIR/.env" <<ENVEOF
NODE_ENV=production
HOST=127.0.0.1
PORT=$APP_PORT
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
# La ruta de Node no siempre es /usr/bin/node (nvm, /opt, compilaciones propias).
NODE_BIN="$(command -v node)"
[[ -x "$NODE_BIN" ]] || die "No se encuentra el ejecutable de node en el PATH."
log "Node en uso: $NODE_BIN"
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
ExecStart=$NODE_BIN src/server.js
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
ExecStart=$NODE_BIN src/workers/index.js
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

# Directivas de nivel http: deben vivir en conf.d, no dentro de un server{}.
mkdir -p /var/cache/nginx/pushflow
cat > /etc/nginx/conf.d/pushflow-http.conf <<'HTTPEOF'
# PushFlow — caché del SDK (se sirve mucho y cambia poco) y límite por IP.
proxy_cache_path /var/cache/nginx/pushflow levels=1:2 keys_zone=pushflow_sdk:10m
                 max_size=100m inactive=24h use_temp_path=off;
limit_req_zone $binary_remote_addr zone=pushflow_public:10m rate=30r/s;
HTTPEOF

# Fragmento con las rutas: sirve tanto para un vhost nuevo como para uno tuyo.
cat > /etc/nginx/snippets/pushflow.conf <<SNIPEOF
# PushFlow — incluir dentro del bloque server{} del dominio $DOMAIN
#
# Nota: las cabeceras CORS y Service-Worker-Allowed las emite la aplicación,
# que conoce los orígenes autorizados de cada app. No se añaden aquí: dos
# cabeceras Access-Control-Allow-Origin distintas hacen que el navegador
# rechace la petición.
#
# Ninguna directiva se declara a nivel de server: si tu vhost ya tuviera la
# misma (client_max_body_size, por ejemplo), nginx abortaría con "duplicate".
# Todo va dentro de las location, que son contextos independientes.

# Cabeceras de proxy comunes a todos los bloques.
# (nginx no permite factorizarlas fuera sin repetir el include, así que van
#  repetidas en cada location.)

# 1. Ficheros estáticos del SDK: se sirven mucho y cambian poco → caché.
#    Debe ir ANTES del bloque de límite de peticiones: entre dos regex,
#    nginx aplica la primera que coincida.
location ~ ^/sdk/v1/(push|pushflow-sw)\.js\$ {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_cache pushflow_sdk;
    proxy_cache_valid 200 1h;
    add_header X-Cache-Status \$upstream_cache_status;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

# 2. Service worker en la raíz (por si sirves PushFlow en su propio dominio).
location = /pushflow-sw.js {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

# 3. Endpoints públicos que llegan desde los navegadores: límite por IP.
location ~ ^/(api/v1/events|api/v1/click|sdk/v1/) {
    limit_req zone=pushflow_public burst=60 nodelay;
    client_max_body_size 512k;
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

# 4. Panel de administración y API REST.
location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    client_max_body_size 4m;
    gzip on;
    gzip_types application/javascript application/json text/css text/plain;
    gzip_min_length 512;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}
SNIPEOF

# ¿Existe ya un vhost con este server_name? Si lo hay, NO se toca.
# `|| true`: con `set -o pipefail`, un grep sin coincidencias (dominio aún sin
# vhost, que es el caso de una instalación nueva) abortaría el script aquí.
EXISTING_VHOST="$(grep -rls "server_name[^;]*\b${DOMAIN}\b" /etc/nginx/ 2>/dev/null \
                  | grep -vE '\.bak|\.save|\.orig|~$|/snippets/' | head -1 || true)"

if [[ "$NGINX_MODE" == "auto" ]]; then
  if [[ -n "$EXISTING_VHOST" ]]; then NGINX_MODE="snippet"; else NGINX_MODE="site"; fi
fi

NGINX_MANUAL_STEP=""

case "$NGINX_MODE" in
  site)
    log "Creando un vhost nuevo para $DOMAIN"
    # Solo se declara la escucha IPv6 si el sistema la admite: en un servidor
    # con IPv6 deshabilitado, `listen [::]:80` impide arrancar nginx entero.
    LISTEN6=""
    if [[ -f /proc/net/if_inet6 ]]; then LISTEN6="    listen [::]:80;"; fi
    cat > /etc/nginx/sites-available/pushflow <<VHOSTEOF
server {
    listen 80;
$LISTEN6
    server_name $DOMAIN;

    include snippets/pushflow.conf;
}
VHOSTEOF
    ln -sf /etc/nginx/sites-available/pushflow /etc/nginx/sites-enabled/pushflow
    # El sitio "default" se deja intacto: puede estar sirviendo otros dominios.
    ;;

  snippet)
    warn "Ya existe un vhost para $DOMAIN en: $EXISTING_VHOST"
    warn "No se toca para no romper tu configuración ni tu certificado."
    NGINX_MANUAL_STEP="  Añade esta línea dentro del bloque server{} de tu dominio
  (el que escucha en 443) en: $EXISTING_VHOST

      include snippets/pushflow.conf;

  Si ese server{} ya tiene un bloque 'location /', sustitúyelo por el include
  o mueve PushFlow a una subruta. Después:

      sudo nginx -t && sudo systemctl reload nginx"
    ;;

  none)
    NGINX_MANUAL_STEP="  Se ha generado /etc/nginx/snippets/pushflow.conf y
  /etc/nginx/conf.d/pushflow-http.conf, pero no se ha activado ningún sitio.
  Añade 'include snippets/pushflow.conf;' donde corresponda y recarga nginx."
    ;;
esac

if [[ "$NGINX_MODE" == "site" ]]; then
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    ok_nginx=true
  else
    warn "La configuración de nginx tiene errores; no se ha recargado:"
    nginx -t 2>&1 | sed 's/^/    /'
  fi
else
  # En modo snippet/none solo se comprueba que lo generado sea válido.
  nginx -t >/dev/null 2>&1 || warn "Revisa 'nginx -t' antes de recargar."
fi

# ---------------------------------------------------------------------------
if [[ "$SKIP_TLS" == false && "$NGINX_MODE" == "site" ]]; then
  log "Solicitando el certificado TLS (Let\'s Encrypt)"
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
    log "HTTPS activo. La renovación es automática."
  else
    warn "No se pudo emitir el certificado. Revisa que el DNS de $DOMAIN apunte aquí"
    warn "y vuelve a ejecutar:  certbot --nginx -d $DOMAIN"
  fi
elif [[ "$SKIP_TLS" == true ]]; then
  log "TLS: se usa el certificado que ya tienes (no se ejecuta certbot)"
fi

log "Configurando el cortafuegos"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
log "Creando el usuario administrador"
ADMIN_EMAIL="${EMAIL:-admin@$DOMAIN}"
ADMIN_PASSWORD="$(openssl rand -base64 12 | tr -d '/+=' | head -c 14)"
ADMIN_CREATED=false
if sudo -u pushflow env "PATH=$PATH" node scripts/create-admin.js \
     --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" --org "PushFlow"; then
  ADMIN_CREATED=true
else
  # Importante: si no se creó, la contraseña generada NO es válida y no debe
  # aparecer en el resumen final.
  ADMIN_PASSWORD=""
  warn "El usuario $ADMIN_EMAIL ya existía: se conserva su contraseña anterior."
fi

cat <<FINAL

────────────────────────────────────────────────────────────────
  PushFlow instalado

  Panel:      https://$DOMAIN
  Usuario:    $ADMIN_EMAIL
$(if [[ "$ADMIN_CREATED" == true ]]; then
    printf '  Contraseña: %s\n\n  Guarda esta contraseña: no se volverá a mostrar.' "$ADMIN_PASSWORD"
  else
    printf '  Contraseña: la que ya tenías (este usuario no se ha vuelto a crear).\n\n  ¿La has perdido? Crea otro usuario:\n    cd %s && sudo -u pushflow node scripts/create-admin.js --email TU@CORREO.COM' "$INSTALL_DIR"
  fi)

  Servicios:  systemctl status pushflow pushflow-worker
  Registros:  journalctl -u pushflow -f
  Config:     $INSTALL_DIR/.env

  Siguiente paso: entra en el panel, crea tu aplicación y copia
  el código de instalación en tu web o en tu APK.
────────────────────────────────────────────────────────────────
FINAL

if [[ -n "$NGINX_MANUAL_STEP" ]]; then
  printf '\033[1;33mFALTA UN PASO MANUAL EN NGINX\033[0m\n\n%s\n\n' "$NGINX_MANUAL_STEP"
fi
