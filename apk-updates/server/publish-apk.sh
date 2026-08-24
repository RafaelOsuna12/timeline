#!/usr/bin/env bash
#
# Publica una versión nueva de la APK en el servidor de actualizaciones.
#
#   sudo bash publish-apk.sh --apk app-release.apk --version-code 14 --version-name 1.4.0 \
#        --changelog "- Arreglado el registro\n- Mejoras de rendimiento"
#
# Copia el APK, calcula su SHA-256, genera latest.json de forma atómica y
# conserva las versiones anteriores para poder revertir.
set -euo pipefail

APK=""
VERSION_CODE=""
VERSION_NAME=""
CHANGELOG=""
MANDATORY=false
MIN_SDK=24
APP_ID="miapp"
BASE_DIR="/var/www/updates"
BASE_URL=""
KEEP=5

usage() {
  cat <<'HELP'
Uso: sudo bash publish-apk.sh --apk <fichero.apk> [opciones]

  --apk <f>            APK firmado de release (obligatorio)
  --version-code <n>   versionCode. Se detecta solo si hay aapt2/apkanalyzer
  --version-name <s>   versionName. Idem
  --app-id <s>         Identificador en la URL (por defecto: miapp)
  --base-url <u>       URL pública (por defecto: https://updates.<dominio>/…)
  --changelog <s>      Notas de la versión (admite \n)
  --mandatory          Marca la actualización como obligatoria
  --min-sdk <n>        API mínima (por defecto 24)
  --dir <ruta>         Directorio raíz (por defecto /var/www/updates)
  --keep <n>           Versiones antiguas a conservar (por defecto 5)
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apk) APK="$2"; shift 2 ;;
    --version-code) VERSION_CODE="$2"; shift 2 ;;
    --version-name) VERSION_NAME="$2"; shift 2 ;;
    --app-id) APP_ID="$2"; shift 2 ;;
    --base-url) BASE_URL="${2%/}"; shift 2 ;;
    --changelog) CHANGELOG="$2"; shift 2 ;;
    --mandatory) MANDATORY=true; shift ;;
    --min-sdk) MIN_SDK="$2"; shift 2 ;;
    --dir) BASE_DIR="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opción desconocida: $1"; usage; exit 1 ;;
  esac
done

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ -n "$APK" ]] || { usage; die "Falta --apk"; }
[[ -f "$APK" ]] || die "No existe el fichero: $APK"

# Un APK es un ZIP: si no lo es, alguien se equivocó de fichero.
unzip -l "$APK" >/dev/null 2>&1 || die "$APK no parece un APK válido (no es un ZIP)."
unzip -l "$APK" 2>/dev/null | grep -q "AndroidManifest.xml" || \
  die "$APK no contiene AndroidManifest.xml: no es un APK."

# Comprobación de firma: un APK sin firmar no se puede instalar como actualización.
if unzip -l "$APK" 2>/dev/null | grep -qE "META-INF/.*\.(RSA|DSA|EC)$"; then
  log "APK firmado (esquema v1 presente)"
elif command -v apksigner >/dev/null; then
  apksigner verify "$APK" >/dev/null 2>&1 && log "APK firmado (verificado con apksigner)" \
    || die "apksigner dice que el APK NO está firmado correctamente."
else
  warn "No se detecta firma v1 y no hay apksigner para comprobar v2/v3."
  warn "Si el APK no está firmado con el MISMO keystore, la actualización fallará."
fi

# --- Detección automática de versión, si hay herramientas -------------------
detect() {
  local tool out
  for tool in aapt2 aapt; do
    if command -v "$tool" >/dev/null; then
      out="$("$tool" dump badging "$APK" 2>/dev/null | grep -m1 "^package:")" || continue
      [[ -z "$VERSION_CODE" ]] && VERSION_CODE="$(sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p" <<<"$out")"
      [[ -z "$VERSION_NAME" ]] && VERSION_NAME="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$out")"
      return
    fi
  done
  if command -v apkanalyzer >/dev/null; then
    [[ -z "$VERSION_CODE" ]] && VERSION_CODE="$(apkanalyzer manifest version-code "$APK" 2>/dev/null || true)"
    [[ -z "$VERSION_NAME" ]] && VERSION_NAME="$(apkanalyzer manifest version-name "$APK" 2>/dev/null || true)"
  fi
}
detect

[[ -n "$VERSION_CODE" ]] || die "No pude detectar el versionCode. Pásalo con --version-code."
[[ -n "$VERSION_NAME" ]] || die "No pude detectar el versionName. Pásalo con --version-name."
[[ "$VERSION_CODE" =~ ^[0-9]+$ ]] || die "--version-code debe ser un entero, no '$VERSION_CODE'."

APP_DIR="$BASE_DIR/$APP_ID"
mkdir -p "$APP_DIR"

# --- No permitir publicar una versión que no sea más nueva ------------------
CURRENT="$APP_DIR/latest.json"
if [[ -f "$CURRENT" ]]; then
  PREV_CODE="$(grep -o '"versionCode"[[:space:]]*:[[:space:]]*[0-9]*' "$CURRENT" | grep -o '[0-9]*$' || echo 0)"
  if (( VERSION_CODE < PREV_CODE )); then
    die "El versionCode $VERSION_CODE es MENOR que el publicado ($PREV_CODE).
     Android no permite bajar de versión: los dispositivos no podrían instalarla."
  fi
  if (( VERSION_CODE == PREV_CODE )); then
    warn "El versionCode $VERSION_CODE ya está publicado. Se sobrescribirá el APK."
  fi
fi

FILENAME="${APP_ID}-${VERSION_NAME}-code${VERSION_CODE}.apk"
DEST="$APP_DIR/$FILENAME"

log "Copiando el APK"
cp "$APK" "$DEST.tmp"
mv -f "$DEST.tmp" "$DEST"          # atómico: nadie descarga un fichero a medias
chmod 644 "$DEST"

SHA256="$(sha256sum "$DEST" | cut -d' ' -f1)"
SIZE="$(stat -c%s "$DEST")"
log "SHA-256: $SHA256"
log "Tamaño:  $(numfmt --to=iec-i --suffix=B "$SIZE" 2>/dev/null || echo "$SIZE bytes")"

[[ -n "$BASE_URL" ]] || BASE_URL="https://updates.example.com/$APP_ID"
URL="$BASE_URL/$FILENAME"

# --- Generar latest.json ----------------------------------------------------
# El escapado del changelog lo hace python: hacerlo en bash es pedir problemas.
python3 - "$APP_DIR" "$VERSION_CODE" "$VERSION_NAME" "$URL" "$SHA256" "$SIZE" \
         "$MIN_SDK" "$MANDATORY" "$CHANGELOG" <<'PYEOF'
import json, os, sys, datetime
app_dir, code, name, url, sha, size, min_sdk, mandatory, changelog = sys.argv[1:10]
manifest = {
    "versionCode": int(code),
    "versionName": name,
    "url": url,
    "sha256": sha,
    "sizeBytes": int(size),
    "minSdk": int(min_sdk),
    "mandatory": mandatory == "true",
    "releasedAt": datetime.datetime.now(datetime.timezone.utc)
                    .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "changelog": changelog.replace("\\n", "\n"),
}
tmp = os.path.join(app_dir, "latest.json.tmp")
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
    f.write("\n")
# Reemplazo atómico: un cliente nunca lee un JSON a medio escribir.
os.replace(tmp, os.path.join(app_dir, "latest.json"))
print(json.dumps(manifest, ensure_ascii=False, indent=2))
PYEOF

chmod 644 "$APP_DIR/latest.json"

# --- Histórico y limpieza ---------------------------------------------------
cp "$APP_DIR/latest.json" "$APP_DIR/version-${VERSION_CODE}.json"
chmod 644 "$APP_DIR/version-${VERSION_CODE}.json"

TOTAL=$(ls -1 "$APP_DIR"/*.apk 2>/dev/null | wc -l)
if (( TOTAL > KEEP )); then
  log "Limpiando versiones antiguas (se conservan $KEEP)"
  ls -1t "$APP_DIR"/*.apk | tail -n +$((KEEP + 1)) | while read -r old; do
    echo "  eliminando $(basename "$old")"
    rm -f "$old"
  done
fi

if id -u www-data >/dev/null 2>&1; then
  chown -R www-data:www-data "$APP_DIR" 2>/dev/null || true
fi

cat <<FINAL

────────────────────────────────────────────────────────────────
  Versión $VERSION_NAME (code $VERSION_CODE) publicada

  Manifiesto: $BASE_URL/latest.json
  APK:        $URL

  Comprueba que se sirve bien:
    curl -s $BASE_URL/latest.json
    curl -sI $URL | head -5

  Avisa a tus usuarios con PushFlow (solo a quien siga en una
  versión anterior):

    curl -X POST https://notificaciones.honorlab.dev/api/v1/notifications \\
      -H "Authorization: Bearer TU_CLAVE" -H "Content-Type: application/json" \\
      -d '{
        "headings": {"es": "Nueva versión disponible"},
        "contents": {"es": "Actualiza a la $VERSION_NAME"},
        "app_url": "miapp://actualizar",
        "channels": ["android"],
        "filters": [{"field":"app_version","relation":"<","value":"$VERSION_NAME"}]
      }'
────────────────────────────────────────────────────────────────

FINAL
