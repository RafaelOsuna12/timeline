# Instalar PushFlow en un subdominio que ya tiene SSL

Guía para el caso más habitual: **ya tienes nginx funcionando y el subdominio
con certificado activo**. El instalador no tocará ni tu vhost ni tu certificado.

Ejemplo usado a lo largo de la guía: `notificaciones.tudominio.com`.

---

## Paso 0 · Diagnóstico (2 minutos)

Conéctate por SSH y ejecuta el diagnóstico. **No modifica nada**, solo informa.

```bash
ssh admin@TU_IP

git clone https://github.com/RafaelOsuna12/timeline.git ~/pushflow-src
cd ~/pushflow-src
git checkout claude/push-notification-system-nzbihe
cd pushflow

sudo bash scripts/preflight.sh notificaciones.tudominio.com
```

Te dirá qué hay ya instalado, si el puerto 3000 está libre, dónde está el vhost
del subdominio, si tiene certificado y si el servidor puede salir a FCM.

**Antes de seguir, comprueba dos cosas en esa salida:**

| Si ves… | Haz esto |
|---|---|
| `Puerto 3000 OCUPADO` | El diagnóstico te sugiere uno libre: añade `--port 3010` |
| `El vhost YA hace proxy_pass` | **Párate.** Ya hay otra aplicación en ese dominio: mira el apartado siguiente |
| Un panel detectado (Plesk, cPanel, CyberPanel, aaPanel…) | Salta al [apartado de paneles](#si-usas-un-panel-de-control) |
| `PostgreSQL … versión 12` o similar | Avísame: hay que decidir si conviven dos versiones |
| `fcm.googleapis.com NO alcanzable` | Tu firewall bloquea la salida; ábrela o Android no funcionará |

### Si el subdominio ya sirve otra aplicación

El diagnóstico te dirá a qué puerto apunta y qué proceso o contenedor lo
atiende. Decide antes de tocar nada:

- **Ya no la necesitas** → quita su `location /` del vhost y pon el `include`
  de PushFlow en su lugar (Paso 2). Para un contenedor, párala también:
  `docker stop <nombre>`.
- **La necesitas y quieres conservarla** → dale a PushFlow otro subdominio
  (`push.tudominio.com`, por ejemplo), con su propio certificado. Es lo más
  limpio: cada aplicación en su dominio.
- **Quieres las dos en el mismo dominio** → posible pero incómodo: PushFlow
  necesita servir rutas en la raíz (`/sdk/`, `/api/`, `/pushflow-sw.js`) y
  chocaría con la otra. Solo tiene sentido si la otra vive bajo un prefijo
  claro como `/app/`.

---

## Paso 1 · Instalar

```bash
sudo bash scripts/install-ubuntu.sh \
  --domain notificaciones.tudominio.com \
  --email tu@correo.com \
  --existing-tls \
  --port 3010          # solo si el 3000 está ocupado
```

`--existing-tls` es la clave: **no instala certbot ni pide certificado**, porque
el tuyo ya funciona. `--port` mantiene el puerto coherente en las tres piezas:
el `.env`, el `proxy_pass` de nginx y el servicio de systemd.

El script instala Node 22 y PostgreSQL 16 si faltan, crea la base de datos con
una contraseña aleatoria, escribe `/opt/pushflow/.env`, aplica las migraciones,
instala los servicios `pushflow` y `pushflow-worker`, y crea tu usuario del panel.

Al terminar imprime la contraseña del administrador. **Cópiala: no se repite.**

Si algo falla a mitad, el script es **idempotente**: puedes volver a lanzarlo.
Conserva el `.env` y la contraseña de la base de datos que ya hubiera.

---

## Paso 2 · Conectar tu nginx

Como ya existe un vhost para el subdominio, el instalador **no lo modifica**.
Termina avisándote de que falta un paso manual y te dice el fichero exacto.

Edita ese fichero:

```bash
sudo nano /etc/nginx/sites-available/notificaciones.tudominio.com
```

Dentro del bloque `server { … }` que escucha en **443**, añade el `include` y
**borra o comenta** lo que sirviera antes ese dominio (`root`, `index`, un
`location /` previo o un `proxy_pass` a otra aplicación):

```nginx
server {
    listen 443 ssl;
    server_name notificaciones.tudominio.com;

    ssl_certificate     /etc/letsencrypt/live/notificaciones.tudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notificaciones.tudominio.com/privkey.pem;

    # ← quita el root/index o el location / anterior

    include snippets/pushflow.conf;      # ← añade esta línea
}
```

Comprueba y recarga:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

> El `include` trae cuatro bloques: caché para los ficheros del SDK, el service
> worker, los endpoints públicos con límite de peticiones por IP, y el panel.
> Las cabeceras CORS las emite la aplicación, que conoce los orígenes
> autorizados de cada app; nginx no las duplica a propósito, porque dos
> cabeceras `Access-Control-Allow-Origin` distintas rompen el navegador.

---

## Paso 3 · Comprobar

```bash
# La aplicación responde por dentro
curl -s http://127.0.0.1:3000/health

# Y a través de tu dominio con HTTPS
curl -s https://notificaciones.tudominio.com/health

# El SDK se sirve y nginx lo cachea (la segunda vez debe poner HIT)
curl -sI https://notificaciones.tudominio.com/sdk/v1/push.js | grep -i x-cache
```

Las tres deben responder. Después entra en
`https://notificaciones.tudominio.com` con el usuario y la contraseña que
imprimió el instalador.

Estado de los servicios:

```bash
sudo systemctl status pushflow pushflow-worker
sudo journalctl -u pushflow -f          # registros en vivo
```

---

## Paso 4 · Crear tu aplicación

1. En el panel, **crear aplicación** con el nombre y la URL de tu web.
2. Guarda la **clave de API** que aparece: solo se muestra una vez.
3. Ve a **Instalación** y sigue los dos pasos que te da para la web.
4. Para Android, sube el JSON de la cuenta de servicio de Firebase.

En **Ajustes** deja configurado, como mínimo:

- **Orígenes autorizados**: los dominios desde los que se registrarán
  suscriptores. Añade tanto `https://tudominio.com` como
  `https://www.tudominio.com` si usas ambos, o `*.tudominio.com`.
- **Petición de permiso**: el aviso deslizante con 5–15 segundos de retraso
  convierte bastante mejor que el nativo inmediato.

---

## Si usas un panel de control

Con Plesk, cPanel, CyberPanel o aaPanel **no edites los ficheros de nginx a
mano**: el panel los regenera y perderías los cambios. Instala así:

```bash
sudo bash scripts/install-ubuntu.sh \
  --domain notificaciones.tudominio.com \
  --email tu@correo.com \
  --existing-tls --nginx-mode none
```

Después, en la interfaz del panel busca la opción de **proxy inverso** para ese
dominio y apúntala a `http://127.0.0.1:3000`. Nombres habituales:

| Panel | Dónde está |
|---|---|
| Plesk | Dominio → *Apache & nginx Settings* → *Additional nginx directives* |
| cPanel | *Application Manager*, o WHM → *Reverse proxy* |
| CyberPanel | *Websites* → *Manage* → *vHost Conf* |
| aaPanel | *Website* → *Config* → *Reverse proxy* |

En «directivas adicionales» puedes pegar directamente el contenido de
`/etc/nginx/snippets/pushflow.conf`, que el instalador deja generado.

---

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `502 Bad Gateway` | La aplicación no está arrancada | `sudo systemctl status pushflow` y mira `journalctl -u pushflow -n 50` |
| Sigue saliendo tu web anterior | El `server{}` conserva su `root`/`location /` | Quítalos: el `include` debe ser quien atienda `/` |
| `nginx: [emerg] duplicate location` | Ya había un `location /` en ese server | Borra el antiguo antes del `include` |
| El panel carga pero no inicia sesión | Contraseña equivocada | `cd /opt/pushflow && sudo -u pushflow node scripts/create-admin.js --email otro@correo.com` |
| El prompt no aparece en tu web | Falta `/pushflow-sw.js` en la raíz de **tu** dominio | Créalo con la única línea que indica la pestaña Instalación |
| Android no recibe nada | Credenciales de FCM sin subir | Panel → Instalación → App Android. El panel valida el JSON contra Google al guardarlo |
| `El puerto 3000 ya está ocupado` | Otra aplicación lo usa | Reinstala con `--port 3001` y ajusta el `proxy_pass` del snippet |

---

## Mantenimiento

```bash
# Copia de seguridad diaria a las 3:00
sudo crontab -e
0 3 * * * /opt/pushflow/deploy/backup.sh

# Actualizar a una versión nueva
cd ~/pushflow-src && git pull
sudo cp -r pushflow/src pushflow/public pushflow/migrations /opt/pushflow/
cd /opt/pushflow && sudo -u pushflow npm ci --omit=dev
sudo -u pushflow node src/db/migrate.js up
sudo systemctl restart pushflow pushflow-worker
```

Las particiones mensuales de eventos y la purga por retención las gestiona el
worker solo, sin intervención.

---

## Seguridad, antes de darlo por terminado

1. **Cambia la contraseña SSH** si la has compartido en algún sitio, y pasa a
   autenticación por clave:
   ```bash
   ssh-copy-id admin@TU_IP
   sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
   sudo systemctl restart ssh
   ```
2. **Cambia la contraseña del panel** desde Ajustes en cuanto entres.
3. `/opt/pushflow/.env` contiene la clave maestra que cifra las credenciales de
   FCM. Está en modo `600` y pertenece al usuario `pushflow`; no lo copies a
   repositorios ni a copias de seguridad sin cifrar.
4. Revisa que el cortafuegos deja abiertos solo 22, 80 y 443:
   ```bash
   sudo ufw status
   ```
