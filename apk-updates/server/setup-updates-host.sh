#!/usr/bin/env bash
#
# Prepara el alojamiento de actualizaciones de APK en un servidor con nginx.
#
#   sudo bash setup-updates-host.sh --domain updates.tudominio.com --email tu@correo.com
#   sudo bash setup-updates-host.sh --domain updates.tudominio.com --existing-tls
#
set -euo pipefail

DOMAIN=""
EMAIL=""
BASE_DIR="/var/www/updates"
SKIP_TLS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --dir) BASE_DIR="$2"; shift 2 ;;
    --existing-tls|--skip-tls) SKIP_TLS=true; shift ;;
    *) echo "Opción desconocida: $1"; exit 1 ;;
  esac
done

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecútalo como root (sudo)."
[[ -n "$DOMAIN" ]] || die "Falta --domain (por ejemplo: updates.tudominio.com)."
command -v nginx >/dev/null || die "nginx no está instalado."

log "Creando $BASE_DIR"
mkdir -p "$BASE_DIR"
chown -R www-data:www-data "$BASE_DIR" 2>/dev/null || true
chmod 755 "$BASE_DIR"

# `|| true`: lo normal es que NO exista el vhost; sin esto pipefail aborta aquí.
EXISTING="$(grep -rls "server_name[^;]*\b${DOMAIN}\b" /etc/nginx/ 2>/dev/null \
            | grep -vE '\.bak|\.save|\.orig|~$|/snippets/' | head -1 || true)"
if [[ -n "$EXISTING" ]]; then
  die "Ya existe un vhost para $DOMAIN en $EXISTING.
     Este script solo crea sitios nuevos: revísalo a mano."
fi

LISTEN6=""
[[ -f /proc/net/if_inet6 ]] && LISTEN6="    listen [::]:80;"

log "Escribiendo el vhost"
cat > /etc/nginx/sites-available/apk-updates <<VHOSTEOF
server {
    listen 80;
$LISTEN6
    server_name $DOMAIN;

    root $BASE_DIR;

    # Los APK son grandes: sendfile + rangos HTTP para descargas reanudables.
    sendfile on;
    tcp_nopush on;
    aio threads;

    # El manifiesto cambia en cada versión: no debe cachearse.
    location ~ \.json\$ {
        add_header Cache-Control "no-cache, must-revalidate" always;
        add_header Access-Control-Allow-Origin "*" always;
        default_type application/json;
        charset utf-8;
    }

    # Los APK llevan el versionCode en el nombre: son inmutables.
    location ~ \.apk\$ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Content-Disposition "attachment" always;
        default_type application/vnd.android.package-archive;
        # nginx ya sirve rangos (Accept-Ranges) en ficheros estáticos.
    }

    # Nada de listar el directorio ni servir otra cosa.
    autoindex off;
    location / {
        try_files \$uri =404;
    }

    access_log /var/log/nginx/apk-updates.access.log;
    error_log  /var/log/nginx/apk-updates.error.log;
}
VHOSTEOF

ln -sf /etc/nginx/sites-available/apk-updates /etc/nginx/sites-enabled/apk-updates

if nginx -t; then
  systemctl reload nginx 2>/dev/null || nginx -s reload
  log "nginx recargado"
else
  rm -f /etc/nginx/sites-enabled/apk-updates
  die "nginx rechazó la configuración. Se ha deshabilitado el sitio."
fi

if [[ "$SKIP_TLS" == false ]]; then
  [[ -n "$EMAIL" ]] || die "Falta --email para el certificado (o usa --existing-tls)."
  command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx
  log "Solicitando el certificado TLS"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect \
    || warn "No se pudo emitir el certificado. Revisa el DNS y repite: certbot --nginx -d $DOMAIN"
fi

cat <<FINAL

────────────────────────────────────────────────────────────────
  Alojamiento de actualizaciones listo

  Directorio: $BASE_DIR
  URL base:   https://$DOMAIN

  Publica tu primera versión:

    sudo bash publish-apk.sh \\
      --apk app-release.apk \\
      --version-code 1 --version-name 1.0.0 \\
      --app-id miapp \\
      --base-url https://$DOMAIN/miapp

  El manifiesto quedará en https://$DOMAIN/miapp/latest.json
────────────────────────────────────────────────────────────────

FINAL
