# Instalación

Tres caminos: instalador automático (recomendado), Docker o manual.

---

## Requisitos previos

- **Ubuntu 22.04 o 24.04** con acceso root
- Un **dominio apuntando al servidor** (registro A hacia la IP del VPS)
- **HTTPS obligatorio**: los navegadores no permiten Web Push sin certificado
- Recursos mínimos: 1 vCPU, 1 GB de RAM, 20 GB de disco

Con esa máquina el sistema mueve holgadamente **100 000 suscriptores** y
picos de varios miles de envíos por minuto. A partir de ahí, lo primero que
conviene ampliar es la RAM de PostgreSQL.

---

## Opción 1 · Instalador automático

```bash
git clone <tu-repositorio> pushflow
cd pushflow
sudo bash scripts/install-ubuntu.sh \
  --domain push.tudominio.com \
  --email tu@correo.com
```

El script:

1. Instala Node.js 22, PostgreSQL 16, Nginx y Certbot
2. Crea la base de datos con una contraseña aleatoria y ajusta PostgreSQL
   al tamaño de la máquina
3. Genera `APP_SECRET` y escribe `/opt/pushflow/.env`
4. Aplica las migraciones
5. Instala y arranca `pushflow` y `pushflow-worker` como servicios de systemd
6. Configura Nginx con caché para el SDK y límite de peticiones
7. Emite el certificado TLS y activa la renovación automática
8. Crea el usuario administrador y muestra su contraseña

Al terminar imprime la URL del panel, el usuario y la contraseña.
**Guarda esa contraseña: no se vuelve a mostrar.**

Opciones:

| Opción | Para qué |
|---|---|
| `--dir /ruta` | Cambiar el directorio de instalación (por defecto `/opt/pushflow`) |
| `--skip-tls` | No pedir certificado (si ya usas Cloudflare o un proxy propio) |

---

## Opción 2 · Docker

```bash
cp .env.example .env
```

Edita `.env` y define al menos:

```ini
PUBLIC_URL=https://push.tudominio.com
APP_SECRET=<openssl rand -base64 48>
PGPASSWORD=<una contraseña larga>
```

```bash
docker compose up -d
docker compose exec app node scripts/create-admin.js --email tu@correo.com
```

Deja un proxy inverso con HTTPS por delante (Nginx, Caddy o Traefik) apuntando
al puerto 3000. El servicio `migrate` aplica el esquema antes de arrancar el
resto y el `worker` corre en su propio contenedor.

---

## Opción 3 · Instalación manual

```bash
# 1. Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 2. PostgreSQL 16
sudo apt install -y postgresql-16
sudo -u postgres psql -c "CREATE ROLE pushflow LOGIN PASSWORD 'tu-clave';"
sudo -u postgres psql -c "CREATE DATABASE pushflow OWNER pushflow;"

# 3. Aplicación
git clone <tu-repositorio> /opt/pushflow && cd /opt/pushflow
npm ci --omit=dev
cp .env.example .env && nano .env        # DATABASE_URL, APP_SECRET, PUBLIC_URL
node src/db/migrate.js up
node scripts/create-admin.js --email tu@correo.com

# 4. Arranque
node src/server.js       # servidor web
node src/workers/index.js  # worker (en otra terminal o servicio)
```

Para producción copia los dos ficheros `.service` que genera
`scripts/install-ubuntu.sh` o usa un gestor de procesos.

> En un VPS muy pequeño puedes poner `WORKER_INLINE=true` en `.env` y ejecutar
> un único proceso: el worker corre dentro del servidor web.

---

## Configuración (.env)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `PUBLIC_URL` | sí | URL pública con HTTPS. Se incrusta en el SDK y en los payloads |
| `DATABASE_URL` | sí | Cadena de conexión a PostgreSQL |
| `APP_SECRET` | sí | Clave maestra: firma cookies y **cifra las credenciales de FCM** |
| `PORT` | no | Puerto interno (3000 por defecto) |
| `WORKER_CONCURRENCY` | no | Trabajos simultáneos por worker (4) |
| `SEND_CONCURRENCY` | no | Envíos simultáneos a los proveedores (50) |
| `WORKER_BATCH_SIZE` | no | Dispositivos por lote (500) |
| `WORKER_INLINE` | no | `true` para ejecutar el worker dentro del servidor |
| `API_RATE_LIMIT` | no | Peticiones por minuto y clave de API (600) |
| `PUBLIC_RATE_LIMIT` | no | Peticiones por minuto e IP en los endpoints del SDK (120) |
| `RETENTION_EVENTS_MONTHS` | no | Meses de eventos que se conservan (13) |
| `GEO_COUNTRY_HEADER` | no | Cabecera con el país que añade tu proxy (`cf-ipcountry`) |

> Si cambias `APP_SECRET`, las credenciales de FCM guardadas dejarán de
> descifrarse y habrá que volver a subirlas.

---

## Después de instalar

1. Entra en el panel y crea tu **aplicación**.
2. Ve a **Instalación** y copia el código para tu web o tu APK.
3. En **Ajustes** configura el prompt de permiso, las horas silenciosas y el
   tope diario de notificaciones.
4. Para Android, sube el JSON de la cuenta de servicio de Firebase.

---

## Mantenimiento

**Copias de seguridad** (diarias a las 3:00):

```bash
sudo crontab -e
0 3 * * * /opt/pushflow/deploy/backup.sh
```

Con `EXCLUDE_EVENTS=1` la copia omite los eventos crudos y las entregas
individuales: ocupa una fracción y conserva suscriptores, notificaciones,
segmentos y agregados.

**Actualizar**:

```bash
cd /opt/pushflow
git pull
npm ci --omit=dev
node src/db/migrate.js up
systemctl restart pushflow pushflow-worker
```

**Particiones y retención.** El worker crea cada día las particiones de los
meses siguientes y elimina las anteriores a `RETENTION_EVENTS_MONTHS`. No hay
que hacer nada a mano.

---

## Resolución de problemas

| Síntoma | Causa habitual | Solución |
|---|---|---|
| El prompt no aparece | El sitio no es HTTPS, o el permiso ya está denegado | Comprueba el candado; en el navegador, restablece los permisos del sitio |
| «Failed to register a ServiceWorker» | Falta `/pushflow-sw.js` en la raíz del dominio | Súbelo tal como indica la pestaña Instalación |
| Las notificaciones web no llegan | Claves VAPID rotadas | Los dispositivos deben volver a registrarse |
| Android no recibe nada | Credenciales de FCM ausentes o incorrectas | Vuelve a subir el JSON; el panel valida contra Google al guardarlo |
| `UNREGISTERED` en los errores | El usuario desinstaló la app | Normal: la suscripción se marca inválida sola |
| Las notificaciones tardan | El worker está parado | `systemctl status pushflow-worker` |
| La cola crece | Un único worker no da abasto | Sube `WORKER_CONCURRENCY` o levanta un segundo worker |

**Ver el estado de la cola** desde el panel (Ajustes → Estado del sistema) o:

```sql
SELECT status, type, count(*) FROM jobs GROUP BY 1, 2;
```
