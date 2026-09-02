# Estadísticas de avance de ventas

Sistema web para analizar el avance de sell-out del equipo de campo y proyectar
el cierre del mes, a partir del reporte diario en Excel
(`R123_DailySO_Models_*.xlsx`).

Pensado para correr en **https://estadisticas.honorlab.dev** con TLS, detrás de
nginx, y para actualizarse subiendo el archivo desde el propio navegador.

---

## Qué hace

**Análisis**

- **Resumen ejecutivo** — avance contra target, curva acumulada frente a la
  curva de objetivo, proyección de cierre con tres escenarios, sell-out diario
  con media móvil, estacionalidad por día de la semana y alertas ordenadas por
  impacto en el cierre.
- **Regiones y canales** — R1, R2 y R3 más cada cadena (Telcel, Coppel,
  Liverpool, Sears, AT&T, Movistar), con cumplimiento, proyección y ritmo
  requerido.
- **CM y supervisores** — el árbol completo Región → City Manager → Supervisor →
  Promotor, con métricas en cada nivel para ubicar exactamente dónde se pierde
  el target.
- **Promotores** — tabla maestra filtrable y ficha individual con detalle diario,
  mezcla de modelos y comparación contra el promedio de su propio equipo.
- **Modelos y mezcla** — participación de cada modelo foco, portafolio completo
  por canal y desglose por versión de operador y color.
- **Tiendas** — desempeño por punto de venta.
- **Asistencia y cero venta** — cobertura de piso y mapa de calor por promotor y
  día, distinguiendo la ausencia del día en piso sin venta.
- **Avance entre cargas** — cuánto se movió cada equipo entre dos
  actualizaciones del archivo.

**Operación**

- Carga del Excel desde el navegador (arrastrar y soltar), con procesamiento en
  segundo plano y avance en pantalla.
- Cada carga se guarda como una versión independiente; se puede volver a
  cualquier actualización anterior.
- Vista retrospectiva: ver el mes tal como se veía en un día anterior.
- Exportación a CSV de promotores, supervisores, tiendas y serie diaria.
- Usuarios con tres roles (administrador, editor, consulta) y bitácora de
  actividad.

Cómo se calcula cada número: [`docs/METRICAS.md`](docs/METRICAS.md).
Qué se lee de cada hoja del Excel: [`docs/ESTRUCTURA_EXCEL.md`](docs/ESTRUCTURA_EXCEL.md).

---

## Instalación en el servidor

Requisitos: Ubuntu o Debian con acceso root, el dominio
`estadisticas.honorlab.dev` apuntando con un registro **A** a la IP pública del
servidor, y los puertos 80 y 443 abiertos.

```bash
# 1. Traer el código (la rama con el sistema)
sudo git clone -b claude/sales-analytics-dashboard-i7pkoj \
  https://github.com/RafaelOsuna12/timeline.git /opt/estadisticas
cd /opt/estadisticas

# 2. Instalar (Node, nginx, servicio, firewall)
sudo bash deploy/install.sh

# 3. Emitir el certificado TLS y activar HTTPS
sudo bash deploy/setup-ssl.sh
```

`install.sh` genera la configuración (`server/.env`) con un `JWT_SECRET`
aleatorio y una contraseña de administrador también aleatoria, que imprime al
terminar. Cámbiala desde **Administración** en el primer acceso.

Al terminar, el sitio queda en **https://estadisticas.honorlab.dev**.

### Actualizar

```bash
sudo bash /opt/estadisticas/deploy/deploy.sh
```

Solo actualiza el código: la base de datos y los archivos cargados no se tocan.
Toma por defecto la misma rama con la que se clonó; para usar otra,
`sudo BRANCH=main bash /opt/estadisticas/deploy/deploy.sh`.

### Respaldos

```bash
sudo bash /opt/estadisticas/deploy/backup.sh /var/backups/estadisticas
```

Para respaldo diario, en el cron de root:

```
0 3 * * * /opt/estadisticas/deploy/backup.sh /var/backups/estadisticas
```

### Operación diaria

```bash
systemctl status estadisticas       # estado del servicio
journalctl -u estadisticas -f       # registros en vivo
sudo certbot renew --dry-run        # probar la renovación del certificado
```

---

## Uso

1. Entra a https://estadisticas.honorlab.dev con tu usuario.
2. **Cargar archivo** → arrastra el `R123_DailySO_Models_*.xlsx` del día.
3. El sistema detecta solo el mes, los días que tiene y el último día con
   información. Tarda entre 20 y 40 segundos.
4. El tablero queda actualizado. Los filtros (región, CM, supervisor, canal,
   búsqueda) se aplican a todas las vistas a la vez y quedan guardados en la
   dirección del navegador, así que se puede compartir un enlace con el corte
   exacto que se está viendo.

Subir el archivo cada día habilita además la vista **Avance entre cargas**, que
muestra cuánto avanzó cada equipo respecto de la actualización anterior.

---

## Desarrollo local

```bash
# Backend (http://127.0.0.1:4000)
cd server
npm install
ADMIN_PASSWORD='una-contrasena-larga' npm run dev

# Frontend con recarga en caliente (http://127.0.0.1:5173)
cd web
npm install
npm run dev
```

Cargar un archivo desde la terminal, sin pasar por la interfaz:

```bash
cd server
npm run ingest -- /ruta/al/R123_DailySO_Models_20260901.xlsx
```

Crear usuarios desde la terminal:

```bash
cd server
node src/scripts/create-user.js jperez 'contrasena-larga' editor 'Juan Perez'
```

---

## Arquitectura

```
server/                     API REST + motor de análisis (Node 20, Express)
  src/parser/               lectura del Excel (detección de estructura)
  src/analytics/            métricas, proyecciones y vistas del tablero
  src/routes/               endpoints de datos, carga y sesión
  src/db.js                 esquema SQLite
web/                        tablero (React + Vite + Recharts)
  src/pages/                una vista por pantalla
  src/components/charts/    gráficos
deploy/                     nginx, systemd y scripts de instalación
docs/                       estructura del Excel y definición de métricas
```

El backend guarda cada carga en SQLite como un snapshot completo (~200
promotores × 31 días). Al consultarse, el snapshot se carga en memoria y todas
las agregaciones se calculan al vuelo, de forma que cualquier corte por región,
equipo, canal o tienda sale de los mismos datos y no puede desincronizarse.

En producción el mismo proceso de Node sirve la API y el frontend compilado;
nginx termina el TLS y hace de proxy inverso hacia `127.0.0.1:4000`.

### Seguridad

- Acceso con usuario y contraseña; sesiones firmadas con JWT (12 horas).
- Contraseñas guardadas con bcrypt.
- Límite de 10 intentos de acceso por IP cada 15 minutos.
- Cabeceras de seguridad (CSP, HSTS, `X-Frame-Options`, `noindex`) y TLS 1.2+.
- El proceso de Node escucha solo en `127.0.0.1`; únicamente nginx lo expone.
- Servicio de systemd endurecido: sin privilegios nuevos, sistema de archivos de
  solo lectura salvo el directorio de datos.
- Bitácora de accesos, cargas y cambios de usuarios.

---

## API

Todas las rutas requieren `Authorization: Bearer <token>` y aceptan los mismos
filtros por query string: `region`, `cm`, `supervisor`, `channel`, `store`,
`search`, `asOfDay`, `snapshot`, `includeOffline`.

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/auth/login` | Iniciar sesión |
| `GET` | `/api/overview` | Resumen ejecutivo |
| `GET` | `/api/hierarchy` | Árbol región → CM → supervisor → promotor |
| `GET` | `/api/promoters` | Tabla de promotores |
| `GET` | `/api/promoters/:id` | Detalle de un promotor |
| `GET` | `/api/models` | Modelos, productos clave y variantes |
| `GET` | `/api/stores` | Desempeño por tienda |
| `GET` | `/api/attendance` | Asistencia y días en cero |
| `GET` | `/api/comparison` | Avance contra la carga anterior |
| `GET` | `/api/export/:dataset.csv` | Exportación (`promotores`, `supervisores`, `tiendas`, `diario`) |
| `POST` | `/api/uploads` | Subir un archivo (roles admin y editor) |
| `GET` | `/api/uploads/jobs/:id` | Avance del procesamiento |
| `GET` | `/api/snapshots` | Historial de cargas |
