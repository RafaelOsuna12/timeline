# Pruebas

| Comando | Qué cubre | Necesita |
|---|---|---|
| `npm test` | Lógica pura: filtros de segmentación, payloads por canal, idiomas, horas silenciosas, cron, criptografía | nada |
| `npm run test:e2e` | Envío completo contra un servidor Web Push simulado: cifrado, entrega, analítica | PostgreSQL con datos de `npm run seed` |
| `npm run test:integration` | 82 comprobaciones sobre la API HTTP: sesión, claves, suscriptores, segmentos, envío, analítica, automatizaciones, subida de imágenes, aislamiento entre apps | servidor y worker en marcha |

La prueba de integración levanta su propio servidor Web Push con un certificado
autofirmado, así que el worker debe arrancarse con
`NODE_TLS_REJECT_UNAUTHORIZED=0` **solo durante la prueba**.

> La suite consume unas 90 peticiones públicas. El límite es de 120 por minuto
> y por IP, así que **no la lances dos veces en el mismo minuto**: la segunda
> recibiría 429. El contador vive en memoria; reiniciar el servidor lo borra.

```bash
npm run migrate && npm run create-admin -- --email admin@demo.com --password "pruebaSegura123"
node src/server.js &
NODE_TLS_REJECT_UNAUTHORIZED=0 node src/workers/index.js &
npm run test:integration
```
