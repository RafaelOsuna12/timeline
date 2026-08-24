# Actualización de APK autoalojada

Actualiza una app Android distribuida **fuera de Google Play** desde tu propio
servidor: manifiesto JSON estático + APK servidos por nginx, y un actualizador
dentro de la app que descarga, **verifica el SHA-256** e instala.

```
  App                     Tu servidor (nginx)
   │  GET latest.json  ──────►  /var/www/updates/miapp/latest.json
   │  ◄── {versionCode: 14, url, sha256}
   │
   │  ¿14 > mi versión?  sí
   │  GET el APK       ──────►  miapp-1.4.0-code14.apk
   │  verifica SHA-256
   │  PackageInstaller → el usuario confirma → instalado
```

---

## Lo que hay que saber antes de empezar

**El keystore es intocable.** El APK nuevo debe firmarse con la misma clave que
el instalado. Si cambia, Android rechaza la actualización
(`STATUS_FAILURE_CONFLICT`) y la única salida es desinstalar, perdiendo los
datos del usuario. Guarda el keystore y sus contraseñas con copia de seguridad.

**No hay instalación silenciosa en un teléfono normal.** El usuario concede
«Instalar apps desconocidas» una vez, y después confirma cada actualización en
un diálogo del sistema. Solo una app propietaria del dispositivo (Android
Enterprise, *device owner*) puede instalar sin intervención.

**El versionCode solo sube.** Android no permite bajar de versión. El script de
publicación lo comprueba y rechaza el intento.

---

## Servidor

### Preparar el alojamiento (una vez)

```bash
sudo bash server/setup-updates-host.sh \
  --domain updates.tudominio.com \
  --email tu@correo.com
```

Crea `/var/www/updates`, el vhost de nginx con las cabeceras correctas
(`application/vnd.android.package-archive`, descargas reanudables, sin listado
de directorio) y pide el certificado. Con `--existing-tls` no toca el TLS.

### Publicar una versión

```bash
sudo bash server/publish-apk.sh \
  --apk app-release.apk \
  --version-code 14 --version-name 1.4.0 \
  --app-id miapp \
  --base-url https://updates.tudominio.com/miapp \
  --changelog "- Arreglado el registro\n- Mejoras de rendimiento"
```

Comprueba que el fichero es un APK firmado, que el `versionCode` no retrocede,
calcula el SHA-256, escribe `latest.json` **de forma atómica** (nadie lee un
JSON a medias) y conserva las 5 versiones anteriores.

Detecta `versionCode` y `versionName` solos si tienes `aapt2` o `apkanalyzer`
en el servidor; si no, pásalos con los parámetros.

| Opción | Para qué |
|---|---|
| `--mandatory` | La app no dejará posponer la actualización |
| `--min-sdk 26` | Versión mínima de Android que puede instalarla |
| `--keep 10` | Cuántas versiones antiguas conservar |
| `--app-id` | Permite alojar varias apps en el mismo servidor |

### El manifiesto

```json
{
  "versionCode": 14,
  "versionName": "1.4.0",
  "url": "https://updates.tudominio.com/miapp/miapp-1.4.0-code14.apk",
  "sha256": "8256e253a0c9…",
  "sizeBytes": 18234567,
  "minSdk": 24,
  "mandatory": false,
  "releasedAt": "2026-08-24T23:42:11Z",
  "changelog": "- Arreglado el registro\n- Mejoras de rendimiento"
}
```

---

## App Android

### 1. Copia las clases

`android/src/main/java/com/honorlab/updater/` → tu proyecto:

| Fichero | Qué hace |
|---|---|
| `AppUpdater.java` | Comprueba, descarga, verifica el hash e instala |
| `UpdateInfo.java` | Modelo del manifiesto, con validación |
| `UpdateInstallReceiver.java` | Resultado de la instalación y diálogo del sistema |

Sin dependencias externas: `HttpURLConnection` y `org.json`, ambos en Android.

### 2. Manifiesto

Copia los permisos y el `receiver` de `android/AndroidManifest-fragmento.xml`.

### 3. Úsalo

```java
AppUpdater updater = new AppUpdater.Builder(this)
        .manifestUrl("https://updates.tudominio.com/miapp/latest.json")
        .appId("miapp")
        .listener(new AppUpdater.Listener() {
            @Override public void onUpdateAvailable(UpdateInfo info) {
                // Pregunta al usuario y luego:
                updater.downloadAndInstall(info);
            }
            @Override public void onProgress(int percent, long hecho, long total) { }
            @Override public void onPermissionRequired() {
                updater.openInstallPermissionSettings();
            }
            @Override public void onError(String mensaje, Exception causa) { }
        })
        .build();

updater.check();
```

`android/EjemploDeUso.java` trae una actividad completa con diálogos,
actualización obligatoria y manejo del resultado.

### Detalles de implementación

- El APK se descarga a `getExternalFilesDir()`: **no necesita permisos de
  almacenamiento** y el sistema lo borra al desinstalar la app.
- Se descarga a `.part` y se renombra al terminar: nunca queda un fichero a
  medias con el nombre bueno.
- Si el hash no coincide, el fichero **se borra** y no se instala.
- Si la versión ya estaba descargada y verificada, no se vuelve a bajar.
- Las descargas de versiones anteriores se limpian solas.
- El manifiesto se rechaza si la URL no es `https` o si el `sha256` no tiene
  64 caracteres.

---

## Avisar con PushFlow

Ya tienes el sistema de notificaciones montado. Avisa solo a quien siga en una
versión anterior:

```bash
curl -X POST https://notificaciones.honorlab.dev/api/v1/notifications \
  -H "Authorization: Bearer TU_CLAVE" \
  -H "Content-Type: application/json" \
  -d '{
    "headings": {"es": "Nueva versión disponible"},
    "contents": {"es": "Actualiza a la 1.4.0 para las últimas mejoras"},
    "app_url": "miapp://actualizar",
    "channels": ["android"],
    "filters": [{"field": "app_version", "relation": "<", "value": "1.4.0"}]
  }'
```

El filtro `app_version` funciona porque el SDK de PushFlow envía la versión de
la app al registrar el dispositivo. Declara el deep link `miapp://actualizar`
en tu actividad de actualización y el clic la abrirá directamente.

---

## Comprobar que todo funciona

```bash
# El manifiesto se sirve sin caché
curl -sI https://updates.tudominio.com/miapp/latest.json | grep -i cache-control

# El APK tiene el tipo correcto y admite descarga parcial
curl -sI https://updates.tudominio.com/miapp/miapp-1.4.0-code14.apk \
  | grep -iE "content-type|accept-ranges"

# El hash servido coincide con el publicado
curl -s https://updates.tudominio.com/miapp/miapp-1.4.0-code14.apk | sha256sum
curl -s https://updates.tudominio.com/miapp/latest.json | grep sha256
```

---

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `STATUS_FAILURE_CONFLICT` | El APK está firmado con otro keystore | Firma con el original. Si se perdió, hay que desinstalar y reinstalar |
| No aparece el diálogo de instalación | Falta el permiso de orígenes desconocidos | `openInstallPermissionSettings()` |
| «La descarga no coincide con la firma publicada» | Descarga truncada, o el APK del servidor cambió sin regenerar el manifiesto | Vuelve a publicar con `publish-apk.sh` |
| El navegador abre el APK en vez de descargarlo | Falta el `Content-Type` | El vhost ya lo pone; comprueba que no lo pisa otro bloque |
| La app no ve la versión nueva | El manifiesto está cacheado | El vhost manda `no-cache`; revisa si hay una CDN delante |
