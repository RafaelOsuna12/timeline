#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Emision y renovacion automatica del certificado TLS con Let's Encrypt.
#
#     sudo bash deploy/setup-ssl.sh
#
# Requisito previo: el dominio ya debe resolver a la IP publica del servidor
# y el puerto 80 debe estar accesible desde internet.
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${DOMAIN:-estadisticas.honorlab.dev}"
EMAIL="${EMAIL:-}"
APP_DIR="${APP_DIR:-/opt/estadisticas}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# nginx cambio la sintaxis de HTTP/2 en la version 1.25.1: antes se activaba
# con "http2" en la linea listen y despues con la directiva "http2 on;".
# El archivo del repositorio usa la forma nueva; esta funcion lo convierte a la
# antigua cuando el servidor tiene una version anterior, para que la misma
# configuracion sirva en cualquier Ubuntu o Debian.
# ---------------------------------------------------------------------------
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

if [[ -z "$EMAIL" ]]; then
  read -rp "Correo para los avisos de vencimiento del certificado: " EMAIL
fi
[[ -n "$EMAIL" ]] || die "El correo es obligatorio para registrar la cuenta en Let's Encrypt."

log "Comprobando que ${DOMAIN} apunte a este servidor"
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [[ -n "$SERVER_IP" && -n "$DOMAIN_IP" && "$SERVER_IP" != "$DOMAIN_IP" ]]; then
  echo "  Aviso: ${DOMAIN} resuelve a ${DOMAIN_IP} y este servidor es ${SERVER_IP}."
  echo "  Si usas un proxy (Cloudflare) es normal; si no, corrige el DNS antes de continuar."
  read -rp "  Continuar de todos modos? [s/N] " answer
  [[ "$answer" =~ ^[sSyY]$ ]] || exit 1
fi

log "Instalando certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq certbot python3-certbot-nginx

mkdir -p /var/www/certbot

log "Solicitando el certificado para ${DOMAIN}"
certbot certonly \
  --webroot -w /var/www/certbot \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  --non-interactive \
  --keep-until-expiring

log "Activando la configuracion de nginx con TLS"
sed "s/estadisticas\.honorlab\.dev/${DOMAIN}/g" \
  "${APP_DIR}/deploy/nginx/estadisticas.honorlab.dev.conf" > "/etc/nginx/sites-available/${DOMAIN}"
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
adapt_http2_syntax "/etc/nginx/sites-available/${DOMAIN}"
nginx -t
systemctl reload nginx

log "Programando la renovacion automatica"
# certbot instala su propio timer; se le añade la recarga de nginx.
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/usr/bin/env bash
systemctl reload nginx
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
systemctl enable --now certbot.timer 2>/dev/null || true

log "Verificando"
sleep 2
if curl -fsS --max-time 15 "https://${DOMAIN}/api/health" >/dev/null; then
  echo "  https://${DOMAIN} responde correctamente."
else
  echo "  No se pudo verificar desde el propio servidor; revisa desde tu navegador."
fi

cat <<FIN

--------------------------------------------------------------------------
El sitio ya funciona con HTTPS:  https://${DOMAIN}

  Renovacion automatica:  systemctl list-timers certbot.timer
  Prueba de renovacion:   sudo certbot renew --dry-run
--------------------------------------------------------------------------
FIN
