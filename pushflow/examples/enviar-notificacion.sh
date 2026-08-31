#!/usr/bin/env bash
# Ejemplos de envío con la API REST de PushFlow.
set -euo pipefail

API="${PUSHFLOW_URL:-https://push.tudominio.com}"
KEY="${PUSHFLOW_KEY:?exporta PUSHFLOW_KEY con tu clave de API}"

send() { curl -sS -X POST "$API/api/v1/$1" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$2"; echo; }

echo "1. Estimar destinatarios antes de enviar"
send notifications/estimate '{"include_all": true}'

echo "2. Notificación simple a todos"
send notifications '{
  "headings": {"es": "👋 Hola"},
  "contents": {"es": "Esto es una prueba de PushFlow"},
  "url": "https://tusitio.com",
  "include_all": true
}'

echo "3. Con imagen, botones y deep link para la APK"
send notifications '{
  "headings":  {"es": "🔥 Oferta relámpago"},
  "contents":  {"es": "50 % de descuento durante 2 horas"},
  "image_url": "https://picsum.photos/800/400",
  "web_url":   "https://tutienda.com/ofertas",
  "app_url":   "mitienda://ofertas",
  "buttons": [
    {"id": "ver", "text": "Ver ofertas", "url": "https://tutienda.com/ofertas"},
    {"id": "no",  "text": "Ahora no"}
  ],
  "include_all": true
}'

echo "4. Segmentada por tags y país"
send notifications '{
  "contents": {"es": "Novedades para clientes Pro de México 🇲🇽"},
  "filters": [
    {"field": "tag", "key": "plan", "relation": "=", "value": "pro"},
    {"field": "country", "relation": "=", "value": "MX"}
  ]
}'

echo "5. Programada a las 9:00 de la hora local de cada usuario"
send notifications '{
  "contents": {"es": "Buenos días ☀️"},
  "include_all": true,
  "delayed_option": "timezone",
  "delivery_time_of_day": "09:00"
}'

echo "6. Test A/B"
send notifications '{
  "contents": {"es": "versión base"},
  "include_all": true,
  "ab_test": {"variants": [
    {"id": "A", "weight": 50, "headings": {"es": "🎁 Regalo para ti"},
     "contents": {"es": "Ábrelo antes de que acabe el día"}},
    {"id": "B", "weight": 50, "headings": {"es": "Tienes un regalo"},
     "contents": {"es": "Caduca hoy"}}
  ]}
}'

echo "7. Registrar una conversión"
send outcomes/record '{"name": "compra", "value": 49.90, "external_user_id": "usuario-123"}'
