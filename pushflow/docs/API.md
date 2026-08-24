# API REST

Base: `https://push.tudominio.com/api/v1`

Autenticación con la clave de API de la aplicación (Ajustes → Claves de API):

```
Authorization: Bearer pf_xxxxxxxx_xxxxxxxxxxxxxxxxxxxx
```

Los cuerpos son JSON. La API acepta **el mismo formato que la de OneSignal**,
así que migrar una integración existente suele ser cambiar la URL y la clave.

Errores:

```json
{ "error": { "code": "invalid_request", "message": "`contents` (mensaje) es obligatorio" } }
```

| Código | Significado |
|---|---|
| 400 `invalid_request` | Falta un campo o tiene un formato inválido |
| 401 `unauthorized` | Clave de API ausente o revocada |
| 403 `forbidden` | La clave no tiene ese permiso, u origen no autorizado |
| 404 `not_found` | El recurso no existe |
| 409 `conflict` | Operación imposible en el estado actual |
| 429 `rate_limited` | Se superó el límite de peticiones. La respuesta incluye `x-ratelimit-reset` con los segundos que faltan |

---

## Notificaciones

### `POST /notifications`

Crea y envía (o programa) una notificación.

```json
{
  "headings":  { "es": "🔥 Oferta de hoy", "en": "🔥 Today's deal" },
  "contents":  { "es": "50 % de descuento hasta medianoche" },
  "url":       "https://tutienda.com/ofertas",
  "app_url":   "mitienda://ofertas",
  "image_url": "https://tutienda.com/banner.jpg",
  "icon_url":  "https://tutienda.com/icono.png",
  "buttons": [
    { "id": "ver",     "text": "Ver ofertas", "url": "https://tutienda.com/ofertas" },
    { "id": "recordar","text": "Recordármelo" }
  ],
  "data": { "campana": "verano-2026" },
  "included_segments": ["8f1c…"],
  "channels": ["web_push", "android"],
  "send_after": "2026-09-01T10:00:00Z"
}
```

**Contenido**

| Campo | Tipo | Descripción |
|---|---|---|
| `contents` * | texto u objeto | Mensaje. `"Hola"` o `{"es":"Hola","en":"Hi"}` |
| `headings` | texto u objeto | Título. Admite emojis |
| `subtitle` | texto u objeto | Línea secundaria |
| `url` | URL | Destino al pulsar (ambos canales) |
| `web_url` / `app_url` | URL | Destino distinto por canal. `app_url` admite deep links |
| `image_url` | URL | Imagen grande. Alias: `big_picture` |
| `icon_url` | URL | Icono. Alias: `chrome_web_icon` |
| `badge_url` | URL | Icono monocromo de la barra de estado |
| `buttons` | array | Hasta 3 botones `{id, text, url, icon}` |
| `data` | objeto | Datos que recibe tu SDK. Alias: `additional_data` |

**Segmentación** (elige uno)

| Campo | Descripción |
|---|---|
| `included_segments` | IDs de segmentos guardados (se suman entre sí) |
| `filters` | Filtros ad-hoc, misma sintaxis que los segmentos |
| `include_subscription_ids` | IDs de dispositivo concretos |
| `include_external_user_ids` | IDs de usuario de tu sistema |
| `include_all: true` | Toda la audiencia |
| `excluded_segments` | Se resta siempre, sea cual sea el modo |

**Entrega**

| Campo | Descripción |
|---|---|
| `send_after` | ISO 8601, epoch o `"in 2 hours"` |
| `delayed_option` | `immediate`, `timezone` o `last-active` |
| `delivery_time_of_day` | `"09:00"` — con `delayed_option: "timezone"` |
| `throttle_rate_per_minute` | Envíos por minuto |
| `ttl` | Segundos que el proveedor guarda el mensaje (259200) |
| `priority` | 1–10; a partir de 8 es alta |
| `collapse_id` | Sustituye la notificación anterior con el mismo id |
| `respect_quiet_hours` | `false` para ignorar las horas silenciosas |
| `respect_frequency_cap` | `false` para ignorar el tope diario |
| `channels` | `["web_push"]`, `["android"]` o ambos |

**Otros**

| Campo | Descripción |
|---|---|
| `ab_test` | Variantes y tamaño de la muestra (ver más abajo) |
| `template_id` | Parte de una plantilla; el cuerpo tiene prioridad |
| `idempotency_key` | Evita duplicados si reintentas la petición |
| `dry_run` | `true` devuelve el número de destinatarios sin enviar nada |
| `draft` | `true` la guarda sin enviarla |
| `require_interaction` | La notificación no se cierra sola (solo escritorio) |
| `android_channel_id` | Canal de Android al que va la notificación |

Respuesta `201`:

```json
{ "id": "3f2a…", "status": "queued", "recipients": 0, "deduplicated": false }
```

`recipients` llega a 0 porque la audiencia se expande en segundo plano;
consulta el informe para ver el resultado real.

### `POST /notifications/estimate`

Cuántos dispositivos alcanzaría, sin enviar nada. Mismo cuerpo de segmentación.

### `GET /notifications?limit=30&offset=0&status=sent`

Historial con métricas resumidas.

### `GET /notifications/:id`

Informe completo: totales, serie horaria, comparativa A/B, desglose por país,
clics por botón, conversiones y errores de entrega.

### `GET /notifications/:id/deliveries?status=failed`

Entregas individuales, para auditar.

### `DELETE /notifications/:id`

Cancela una notificación programada o en curso.

### Tests A/B

```json
{
  "contents": { "es": "texto por defecto" },
  "included_segments": ["8f1c…"],
  "ab_test": {
    "sample_percent": 30,
    "variants": [
      { "id": "A", "weight": 50, "headings": {"es": "🎁 Regalo"},   "contents": {"es": "Ábrelo hoy"} },
      { "id": "B", "weight": 50, "headings": {"es": "Tienes algo"}, "contents": {"es": "Caduca hoy"} }
    ]
  }
}
```

`sample_percent` (1–100, por defecto 100) es la parte de la audiencia que
participa en la prueba. El reparto es **determinista**: la misma suscripción
cae siempre del mismo lado, de modo que el resto queda reservado para la
variante ganadora.

### `POST /notifications/:id/winner`

Cierra el test: envía la variante con mejor CTR (o la de `variant_id`) **al
resto de la audiencia**, excluyendo a quien ya recibió cualquier variante.
Con `sample_percent: 100` no queda nadie fuera, así que conviene reservar una
parte al crear el test.

---

## Suscriptores

### `POST /subscriptions`

Alta o actualización de un dispositivo. Es idempotente: dos llamadas con el
mismo `endpoint` o `fcm_token` actualizan el mismo registro.

```json
{
  "channel": "web_push",
  "endpoint": "https://fcm.googleapis.com/fcm/send/…",
  "keys": { "p256dh": "…", "auth": "…" },
  "external_user_id": "usuario-123",
  "tags": { "plan": "pro" },
  "language": "es",
  "timezone_offset": -360
}
```

Para Android: `{"channel":"android","fcm_token":"…"}`.

### `GET /subscriptions?status=active&channel=android&search=…`
### `GET /subscriptions/:id` · `PATCH /subscriptions/:id` · `DELETE /subscriptions/:id`

`PATCH` admite `tags`, `external_user_id`, `language`, `country`, `subscribed`,
`test_type`. En `tags`, un valor `null` borra la etiqueta.

### `POST /subscriptions/bulk-tag`

Etiqueta en bloque a quienes cumplan unos filtros.

```json
{ "filters": [{"field":"country","relation":"=","value":"MX"}],
  "tags": { "region": "latam" } }
```

---

## Usuarios

| Endpoint | Descripción |
|---|---|
| `GET /users/:externalId` | Todos los dispositivos de un usuario |
| `PUT /users/:externalId/tags` | Etiqueta todos sus dispositivos |
| `DELETE /users/:externalId` | Borrado completo (derecho de supresión) |

---

## Segmentos

### `POST /segments`

```json
{
  "name": "Clientes VIP inactivos",
  "filters": [
    { "field": "tag", "key": "plan", "relation": "=", "value": "pro" },
    { "field": "last_session", "relation": ">", "hours_ago": 720 },
    { "operator": "OR" },
    { "field": "tag", "key": "_amount_spent", "relation": ">", "value": 500 }
  ]
}
```

Los filtros consecutivos se combinan con **Y**; `{"operator":"OR"}` abre un
grupo nuevo. El resultado es `(grupo 1) O (grupo 2) O …`.

**Campos disponibles**

| Campo | Relaciones | Notas |
|---|---|---|
| `tag` | `=` `!=` `>` `<` `exists` `not_exists` | Requiere `key`. Compara como número si ambos lados lo son |
| `country` `language` `city` `region` | `=` `!=` | `value` admite un array |
| `channel` | `=` | `web_push` o `android` |
| `browser_name` `device_os` `device_type` | `=` `!=` | |
| `app_version` `sdk_version` | `=` `!=` `>` `<` | Comparación lexicográfica |
| `session_count` `session_time` | `>` `<` `=` | Número de sesiones / segundos totales |
| `last_session` `first_session` `last_notification` | `>` `<` | Con `hours_ago`. `>` = «hace más de» |
| `location` | — | `{"lat":19.43,"long":-99.13,"radius":5000}` en metros |
| `external_user_id` | `=` `!=` `exists` | |
| `test_type` | `=` | `2` = usuario de prueba |

Otros endpoints: `GET /segments`, `GET /segments/:id`, `PATCH /segments/:id`,
`DELETE /segments/:id` y `POST /segments/preview` (recuento y muestra sin guardar).

---

## Analítica

| Endpoint | Devuelve |
|---|---|
| `GET /analytics/overview?days=30` | Audiencia, totales, CTR y serie diaria |
| `GET /analytics/growth?days=30` | Altas y bajas por día |
| `GET /analytics/breakdown/:dimension` | `country`, `language`, `browser`, `os`, `device`, `channel`, `city` |
| `GET /analytics/events?type=clicked&bucket=day` | Serie temporal de un tipo de evento |
| `GET /analytics/outcomes?days=30` | Conversiones por atribución |
| `GET /analytics/top-notifications` | Ranking por CTR |

### `POST /outcomes/record`

Registra una conversión desde tu backend:

```json
{ "name": "compra", "value": 49.90, "external_user_id": "usuario-123" }
```

El servidor la atribuye sola: **directa** si el usuario pulsó una notificación
dentro de la ventana, **influenciada** si solo la recibió, y **no atribuida**
en caso contrario.

### `POST /exports` → `GET /exports/:id`

Exportación a CSV en segundo plano de `subscriptions`, `notifications`,
`events` o `deliveries`.

---

## Automatizaciones

### `POST /automations`

```json
{
  "name": "Carrito abandonado",
  "trigger": { "type": "event", "event_name": "carrito_abandonado" },
  "steps": [
    { "type": "wait", "minutes": 60 },
    { "type": "condition", "filters": [{"field":"tag","key":"compro","relation":"not_exists"}] },
    { "type": "send", "payload": { "title": "¿Lo dejas ahí? 🛒",
                                   "message": "Tu carrito te espera",
                                   "url": "https://tutienda.com/carrito" } },
    { "type": "tag", "tags": { "recordatorio_enviado": "si" } }
  ],
  "status": "active"
}
```

Disparadores: `subscription_created`, `event`, `tag_changed`, `inactivity`
(`inactive_days`) y `schedule` (`cron` de 5 campos, en UTC).

### `POST /events/track`

Dispara automatizaciones desde tu backend:

```json
{ "event_name": "carrito_abandonado", "external_user_id": "usuario-123",
  "properties": { "importe": 120 } }
```

---

## Webhooks

### `POST /webhooks`

```json
{ "url": "https://tuapp.com/hooks/pushflow",
  "events": ["notification.sent", "notification.clicked", "subscription.created"] }
```

La respuesta incluye el `secret` **una sola vez**. Cada entrega lleva la
cabecera `X-PushFlow-Signature: t=<epoch>,v1=<hmac-sha256>` calculada sobre
`"<t>.<cuerpo>"`. Verifícala antes de confiar en el contenido.

Eventos: `notification.sent`, `notification.completed`, `notification.clicked`,
`subscription.created`, `subscription.updated`, `subscription.removed`,
`outcome.recorded`.

---

## Endpoints públicos (sin clave de API)

Los usan los SDK. Se identifican con `app_id` y se validan contra los orígenes
autorizados de la aplicación.

| Endpoint | Uso |
|---|---|
| `GET /sdk/v1/config?app_id=…` | Configuración pública y clave VAPID |
| `POST /sdk/v1/subscribe` | Alta del dispositivo |
| `POST /sdk/v1/subscription/:id/update` | Tags, idioma, `external_user_id` |
| `DELETE /sdk/v1/subscription/:id` | Baja |
| `POST /sdk/v1/session` | Inicio y fin de sesión |
| `POST /api/v1/events` | Recepción, clic y descarte |
| `GET /api/v1/click` | Redirección con registro del clic |
| `GET /sdk/v1/in-app` | Mensajes in-app pendientes |

---

## Límites

- 600 peticiones/minuto por clave de API (`API_RATE_LIMIT`)
- 120 peticiones/minuto por IP en los endpoints públicos (`PUBLIC_RATE_LIMIT`)
- 300 peticiones/minuto por IP en el panel
- **10 intentos de acceso cada 5 minutos por IP** (protección contra fuerza bruta)
- Payload de Web Push: ~4 KB una vez cifrado (título + texto + URLs)
- 3 botones por notificación
- 200 tags por dispositivo
