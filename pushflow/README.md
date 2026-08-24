# PushFlow

Sistema de notificaciones push autoalojado, alternativa completa a OneSignal.
Se instala en un VPS con **Ubuntu** y **PostgreSQL 16**, y envía notificaciones
a **páginas web** (Web Push) y a **aplicaciones Android** (APK, vía FCM).

```
┌──────────────┐   1 línea de código    ┌─────────────────┐
│  Tu web      │ ─────────────────────► │                 │
├──────────────┤                        │    PushFlow     │──► Web Push (VAPID)
│  Tu APK      │ ─── SDK de Kotlin ───► │  Node + Postgres│──► FCM (Android)
└──────────────┘                        └─────────────────┘
                                               │
                                        Panel web con analítica
```

## Qué incluye

**Envío**
- Notificaciones con título, mensaje, **emojis**, **imagen grande**, icono,
  y hasta **3 botones de acción**
- Apertura de **página web** o **deep link de la app** (`miapp://pantalla/42`)
- Programación por fecha, **por hora local de cada usuario** y por hora de
  máxima actividad
- **Test A/B** con reparto por pesos y envío automático de la variante ganadora
- Plantillas, contenido **multi-idioma** y personalización con `{{tags}}`
- Control de ritmo (throttling), horas silenciosas y tope diario por usuario

**Audiencia**
- Segmentos dinámicos con la misma sintaxis de filtros que OneSignal:
  tags, país, idioma, navegador, versión, actividad y **radio geográfico**
- Tags por dispositivo y por usuario, `external_user_id`, alias
- Suscriptores de prueba, opt-out y borrado completo (RGPD)

**Automatizaciones**
- Bienvenida, carrito abandonado, reenganche por inactividad y envíos por cron
- Pasos encadenados: esperar → condición → enviar → etiquetar

**Analítica**
- Recepción confirmada en el dispositivo, clic, **clic por botón** y descarte
- CTR, tasa de entrega, conversiones con atribución **directa / influenciada**
- Desgloses por país, navegador, sistema operativo, idioma y dispositivo
- Series temporales, crecimiento de la audiencia y exportación a CSV

**Plataforma**
- Multi-app y multi-usuario con roles
- API REST compatible con la de OneSignal, webhooks firmados, mensajes in-app
- Panel web propio, ligero y en español

## Instalación rápida

```bash
git clone <tu-repositorio> pushflow && cd pushflow
sudo bash scripts/install-ubuntu.sh --domain push.tudominio.com --email tu@correo.com
```

El instalador deja listo Node.js 22, PostgreSQL 16, Nginx con HTTPS, los
servicios de systemd y el usuario administrador.

- **¿Tu dominio ya tiene nginx y SSL?** Usa `--existing-tls`: el instalador no
  tocará tu vhost ni tu certificado.
  Guía paso a paso: **[docs/INSTALAR-EN-TU-SERVIDOR.md](docs/INSTALAR-EN-TU-SERVIDOR.md)**
- Detalle completo y alternativas (Docker, manual): **[docs/INSTALACION.md](docs/INSTALACION.md)**
- Diagnóstico previo: `sudo bash scripts/preflight.sh tu-dominio.com`

## Integración

**Página web** — dos pasos:

```html
<!-- 1. Fichero /pushflow-sw.js en la raíz de tu dominio: -->
importScripts('https://push.tudominio.com/sdk/v1/pushflow-sw.js');
```

```html
<!-- 2. Una línea antes de </body>: -->
<script src="https://push.tudominio.com/sdk/v1/push.js"
        data-app-id="TU-APP-ID" async></script>
```

**Aplicación Android** — una llamada:

```kotlin
PushFlow.init(this, appId = "TU-APP-ID", apiUrl = "https://push.tudominio.com")
```

Guías completas: **[docs/INTEGRACION-WEB.md](docs/INTEGRACION-WEB.md)** ·
**[android-sdk/README.md](android-sdk/README.md)**

## Enviar una notificación

```bash
curl -X POST https://push.tudominio.com/api/v1/notifications \
  -H "Authorization: Bearer pf_tu_clave" \
  -H "Content-Type: application/json" \
  -d '{
    "headings":  { "es": "🔥 Oferta de hoy" },
    "contents":  { "es": "50 % de descuento hasta medianoche" },
    "image_url": "https://tutienda.com/banner.jpg",
    "url":       "https://tutienda.com/ofertas",
    "buttons":   [{ "id": "ver", "text": "Ver ofertas" }],
    "included_segments": ["<id-del-segmento>"]
  }'
```

Referencia completa de la API: **[docs/API.md](docs/API.md)**

## Arquitectura

| Pieza | Tecnología | Por qué |
|---|---|---|
| Servidor | Node.js 22 + Fastify | Miles de peticiones por segundo con ~80 MB de RAM |
| Datos | PostgreSQL 16 | Tablas de eventos particionadas por mes; sin otra base de datos |
| Cola | PostgreSQL `SKIP LOCKED` | Sin Redis ni RabbitMQ: una dependencia menos que mantener |
| Web Push | VAPID (RFC 8291) | Estándar de los navegadores, sin intermediarios |
| Android | FCM HTTP v1 | El único transporte que Google permite |
| Panel | HTML + JS sin framework | Sin compilación; se sirve tal cual |
| SDK web | 23 KB sin minificar | Una etiqueta `<script>` |

Dependencias de producción: **8 paquetes** (`fastify`, cuatro plugins suyos,
`pg` y `web-push`).

## Requisitos

- Ubuntu 22.04 o 24.04 · 1 vCPU y 1 GB de RAM bastan para empezar
- Un dominio con HTTPS (obligatorio: los navegadores no permiten Web Push sin él)
- Para Android: un proyecto de Firebase (gratuito)

## Operación

```bash
systemctl status pushflow pushflow-worker    # estado
journalctl -u pushflow -f                    # registros
node scripts/create-admin.js --email tu@correo.com
node src/db/migrate.js status                # migraciones
bash deploy/backup.sh                        # copia de seguridad
npm test                                     # pruebas
```

## Estructura

```
src/
  server.js            servidor HTTP y registro de rutas
  config.js            configuración por variables de entorno
  db/                  conexión y migraciones
  lib/                 criptografía, validación, cron, user-agent
  services/
    audience.js        motor de segmentos (filtros → SQL)
    dispatcher.js      expansión de audiencia y envío por lotes
    payload.js         construcción del mensaje por canal
    analytics.js       eventos, agregados y atribución
    automation.js      journeys y disparadores
    channels/          web push y FCM
  routes/              API REST, endpoints del SDK y panel
  workers/             procesamiento de la cola y tareas periódicas
public/
  sdk/v1/              SDK web y service worker
  dashboard/           panel de administración
android-sdk/           librería Kotlin y app de ejemplo
migrations/            esquema de PostgreSQL
scripts/               instalador y utilidades
docs/                  documentación
```

## Licencia

MIT
