#!/usr/bin/env bash
#
# Diagnóstico previo a la instalación de PushFlow. NO modifica nada.
#
#   sudo bash scripts/preflight.sh notificaciones.tudominio.com
#
# Muestra qué hay ya en el servidor para elegir la instalación adecuada.
set -uo pipefail

DOMAIN="${1:-}"
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
no()   { printf '  \033[1;31m✗\033[0m %s\n' "$*"; }
info() { printf '  \033[1;34m·\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

head_ "Sistema"
info "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -a)"
info "Arquitectura: $(uname -m) · Kernel: $(uname -r)"
info "CPU: $(nproc) núcleos · RAM: $(free -h | awk '/^Mem:/{print $2}') · Libre: $(free -h | awk '/^Mem:/{print $7}')"
info "Disco en /: $(df -h / | awk 'NR==2{print $4" libres de "$2}')"
[[ $EUID -eq 0 ]] && ok "Ejecutando como root" || warn "Sin root: relanza con sudo para ver todo"

head_ "Node.js"
if command -v node >/dev/null; then
  V=$(node -v); MAJOR=$(echo "$V" | sed 's/v\([0-9]*\).*/\1/')
  [[ "$MAJOR" -ge 20 ]] && ok "Node $V (válido, se requiere >= 20)" || warn "Node $V es antiguo: el instalador pondrá la 22"
else
  info "No instalado — el instalador pondrá Node 22"
fi

head_ "PostgreSQL"
if command -v psql >/dev/null; then
  ok "Cliente psql: $(psql --version | awk '{print $3}')"
  if systemctl is-active --quiet postgresql 2>/dev/null; then
    SV=$(sudo -u postgres psql -tAc 'SHOW server_version;' 2>/dev/null | tr -d ' ')
    [[ -n "$SV" ]] && ok "Servidor activo, versión $SV" || warn "Servicio activo pero no responde a psql"
    MAJ="${SV%%.*}"
    if [[ -n "$MAJ" && "$MAJ" -lt 14 ]]; then
      warn "Versión $SV: PushFlow necesita 14 o superior (probado en 16)"
    fi
    EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='pushflow'" 2>/dev/null)
    [[ "$EXISTS" == "1" ]] && warn "Ya existe una base de datos llamada 'pushflow'" \
                           || info "No existe la base 'pushflow' (se creará)"
  else
    warn "psql instalado pero el servicio no está activo"
  fi
else
  info "No instalado — el instalador pondrá PostgreSQL 16"
fi

head_ "Servidor web"
FRONT=""
for svc in nginx apache2 httpd caddy; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    ok "$svc está activo"; FRONT="$svc"
  fi
done
[[ -z "$FRONT" ]] && info "Ningún servidor web activo detectado"

if command -v nginx >/dev/null; then
  info "nginx $(nginx -v 2>&1 | sed 's|.*/||')"
  info "Sitios habilitados: $(ls /etc/nginx/sites-enabled/ 2>/dev/null | tr '\n' ' ')"
fi

head_ "Paneles de control"
FOUND_PANEL=""
for p in /usr/local/psa:Plesk /usr/local/cpanel:cPanel /usr/local/CyberCP:CyberPanel \
         /www/server/panel:aaPanel /usr/local/directadmin:DirectAdmin /opt/cloudpanel:CloudPanel; do
  DIR="${p%%:*}"; NAME="${p##*:}"
  [[ -d "$DIR" ]] && { warn "$NAME detectado en $DIR"; FOUND_PANEL="$NAME"; }
done
[[ -z "$FOUND_PANEL" ]] && ok "Sin panel de control: nginx se gestiona a mano"

head_ "Puertos en uso"
for port in 80 443 3000 5432; do
  LINE=$( (ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | grep -E ":$port\b" | head -1)
  if [[ -n "$LINE" ]]; then
    PROC=$(echo "$LINE" | grep -oP '(?<=users:\(\(")[^"]+' | head -1)
    [[ "$port" == "3000" ]] && warn "Puerto 3000 OCUPADO por ${PROC:-?} — habrá que usar otro" \
                            || info "Puerto $port en uso por ${PROC:-?}"
  else
    [[ "$port" == "3000" ]] && ok "Puerto 3000 libre" || info "Puerto $port libre"
  fi
done

if [[ -n "$DOMAIN" ]]; then
  head_ "Dominio $DOMAIN"
  IP_LOCAL=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo "?")
  IP_DNS=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
  info "IP pública del servidor: ${IP_LOCAL}"
  info "El DNS de $DOMAIN apunta a: ${IP_DNS:-no resuelve}"
  [[ -n "$IP_DNS" && "$IP_DNS" == "$IP_LOCAL" ]] && ok "El DNS apunta a este servidor" \
    || warn "El DNS no coincide con la IP local (normal si usas Cloudflare en modo proxy)"

  CONF=$(grep -rls "server_name[^;]*\b${DOMAIN}\b" /etc/nginx/ 2>/dev/null | head -3)
  if [[ -n "$CONF" ]]; then
    ok "Ya existe un vhost de nginx para el dominio:"
    echo "$CONF" | sed 's/^/      /'
    if grep -qs "ssl_certificate" $CONF; then
      ok "Ese vhost ya tiene certificado TLS configurado"
      grep -hs "ssl_certificate " $CONF | head -2 | sed 's/^\s*/      /'
    else
      warn "El vhost existe pero no se ve ssl_certificate en él"
    fi
    ROOT=$(grep -hs -m1 "^\s*root\s" $CONF | awk '{print $2}' | tr -d ';')
    [[ -n "$ROOT" ]] && info "Raíz de documentos actual: $ROOT"
    grep -qs "proxy_pass" $CONF && warn "El vhost ya hace proxy_pass a algo: revísalo antes de añadir PushFlow"
  else
    info "No hay ningún vhost de nginx con ese server_name"
    [[ -n "$FOUND_PANEL" ]] && warn "Lo gestiona $FOUND_PANEL: añade el proxy desde su interfaz"
  fi

  CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
  if [[ -d "$CERT_DIR" ]]; then
    ok "Certificado Let's Encrypt en $CERT_DIR"
    command -v openssl >/dev/null && \
      info "Caduca: $(openssl x509 -enddate -noout -in "$CERT_DIR/fullchain.pem" 2>/dev/null | cut -d= -f2)"
  else
    info "Sin certificado de Let's Encrypt propio para el dominio (puede estar en otra ruta o en un panel)"
  fi
fi

head_ "Salida a internet (necesaria para enviar notificaciones)"
for host in https://fcm.googleapis.com https://oauth2.googleapis.com https://updates.push.services.mozilla.com; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$host" 2>/dev/null)
  [[ "$CODE" != "000" ]] && ok "$host alcanzable (HTTP $CODE)" || no "$host NO alcanzable"
done

head_ "Resumen"
echo "  Copia toda esta salida y pégamela para que adapte la instalación."
