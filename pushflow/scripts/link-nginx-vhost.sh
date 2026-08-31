#!/usr/bin/env bash
#
# Conecta un vhost de nginx existente con PushFlow, de forma reversible.
#
#   sudo bash scripts/link-nginx-vhost.sh notificaciones.tudominio.com
#
# Hace una copia de seguridad, comenta el `location /` que hubiera, inserta
# `include snippets/pushflow.conf;` y valida. Si nginx no valida, restaura
# la copia automáticamente y no recarga nada.
set -euo pipefail

DOMAIN="${1:-}"
ASSUME_YES=false
[[ "${2:-}" == "--yes" ]] && ASSUME_YES=true

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecútalo como root (sudo)."
[[ -n "$DOMAIN" ]] || die "Uso: sudo bash scripts/link-nginx-vhost.sh <dominio> [--yes]"
[[ -f /etc/nginx/snippets/pushflow.conf ]] || \
  die "Falta /etc/nginx/snippets/pushflow.conf. Ejecuta antes el instalador."

# Se excluyen copias de seguridad: enlazar una .bak no serviría de nada.
# `|| true`: sin coincidencias, pipefail abortaría antes de poder dar el aviso.
VHOST="$(grep -rls "server_name[^;]*\b${DOMAIN}\b" /etc/nginx/sites-available/ /etc/nginx/conf.d/ 2>/dev/null \
         | grep -vE '\.bak|\.save|\.orig|~$|/snippets/' | head -1 || true)"
[[ -n "$VHOST" ]] || die "No encuentro ningún vhost con server_name $DOMAIN."

log "Vhost encontrado: $VHOST"

if grep -q "snippets/pushflow.conf" "$VHOST"; then
  warn "Ese vhost ya incluye PushFlow. No hay nada que hacer."
  exit 0
fi

BACKUP="${VHOST}.bak-$(date +%Y%m%d-%H%M%S)"
cp -a "$VHOST" "$BACKUP"
log "Copia de seguridad: $BACKUP"

python3 - "$VHOST" "$DOMAIN" <<'PYEOF'
import re, sys

path, domain = sys.argv[1], sys.argv[2]
text = open(path).read()

def find_server_blocks(s):
    """Devuelve (inicio, fin) de cada bloque server { ... }, con llaves balanceadas."""
    blocks = []
    for m in re.finditer(r'\bserver\s*\{', s):
        depth, i = 0, m.end() - 1
        while i < len(s):
            if s[i] == '{': depth += 1
            elif s[i] == '}':
                depth -= 1
                if depth == 0:
                    blocks.append((m.start(), i + 1)); break
            i += 1
    return blocks

target = None
for start, end in find_server_blocks(text):
    block = text[start:end]
    if not re.search(r'server_name[^;]*\b' + re.escape(domain) + r'\b', block):
        continue
    # Preferimos el bloque que sirve HTTPS; el de :80 suele ser solo redirección.
    if re.search(r'listen[^;]*\b443\b', block):
        target = (start, end); break
    if target is None:
        target = (start, end)

if target is None:
    print("ERROR: no se encontró un bloque server para el dominio", file=sys.stderr)
    sys.exit(2)

start, end = target
block = text[start:end]

# Comenta el `location / { ... }` existente, con llaves balanceadas.
def comment_location_root(b):
    m = re.search(r'^([ \t]*)location\s+/\s*\{', b, re.M)
    if not m:
        return b, False
    depth, i = 0, m.end() - 1
    while i < len(b):
        if b[i] == '{': depth += 1
        elif b[i] == '}':
            depth -= 1
            if depth == 0:
                i += 1; break
        i += 1
    original = b[m.start():i]
    commented = "\n".join("#" + ln for ln in original.split("\n"))
    header = ("\n    # --- Comentado por PushFlow el instalar en este dominio ---\n"
              "    # Para revertir, descomenta este bloque y quita el include de abajo.\n")
    return b[:m.start()] + header + commented + b[i:], True

block, replaced = comment_location_root(block)

# Inserta el include justo antes de la llave de cierre del server.
closing = block.rfind('}')
block = block[:closing] + "\n    include snippets/pushflow.conf;\n" + block[closing:]

open(path, 'w').write(text[:start] + block + text[end:])
print("LOCATION_COMENTADO" if replaced else "SIN_LOCATION_PREVIO")
PYEOF

log "Diferencias aplicadas"
diff -u "$BACKUP" "$VHOST" | sed 's/^/  /' || true

if [[ "$ASSUME_YES" == false ]]; then
  printf '\n¿Aplicar estos cambios y recargar nginx? [s/N] '
  read -r ANSWER </dev/tty
  if [[ ! "$ANSWER" =~ ^[sSyY]$ ]]; then
    cp -a "$BACKUP" "$VHOST"
    warn "Cancelado. El vhost se ha dejado como estaba."
    exit 0
  fi
fi

log "Validando la configuración de nginx"
if nginx -t; then
  systemctl reload nginx 2>/dev/null || nginx -s reload
  log "nginx recargado. PushFlow ya atiende https://$DOMAIN"
  echo "  Copia de seguridad conservada en: $BACKUP"
else
  cp -a "$BACKUP" "$VHOST"
  die "nginx rechazó la configuración. Se ha restaurado $BACKUP y NO se ha recargado."
fi
