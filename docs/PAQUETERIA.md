# Paquetería

Guías de mensajería en camino hacia supervisores, mandos medios y oficinas de
HONOR. Sustituye al Excel que se llevaba a mano y deja la información lista
para la función de notificaciones de llegada.

## Por qué está separada del resto del sistema

Todo lo demás en el sitio **se deriva de un archivo**: ventas y plantilla son
*snapshots* inmutables que se vuelven a crear completos en cada carga. Si se
borra la base, se vuelven a subir los Excel y no se perdió nada.

Paquetería es lo contrario. Se captura a mano, cambia de estado con el tiempo
y **no se puede reconstruir desde ningún archivo**. De ahí tres decisiones que
recorren todo el módulo:

| Decisión | Motivo |
|---|---|
| Tablas `pkg_*` sin `snapshot_id` ni periodo | Un paquete está en camino hoy, no «en noviembre» |
| Borrado lógico (`deleted_at`), nunca físico | Lo que no se puede regenerar no se tira |
| Bitácora de cada cambio (`pkg_events`) | Explica después qué pasó, y alimenta las notificaciones |
| Respaldo diario programado por el instalador | Antes era opcional; con datos capturados a mano, no |

La pantalla tampoco lleva la barra de periodo del tablero, y el encabezado
omite la línea del corte (`showSnapshot={false}` en `AppShell`).

## Lo que se calcula y no se guarda

Tres datos salen siempre de la fecha, nunca de una columna:

- **`late`** — la guía está abierta y su fecha estimada ya pasó.
- **`daysToEta`** — días que faltan, o de retraso si es negativo.
- **`bucket`** — el tramo de la agenda: `retrasado`, `hoy`, `manana`,
  `semana`, `despues` o `sin_fecha`.

Guardarlos como banderas los dejaría mintiendo a la medianoche siguiente.

El día de hoy se calcula en la zona horaria de la operación
(`TIMEZONE`, por omisión `America/Mexico_City`), no en UTC: a las seis de la
tarde en México ya es el día siguiente en UTC, y un paquete aparecería
retrasado un día antes de tiempo.

En el navegador, las fechas sueltas se muestran con `dayLabel()`, que **no**
construye un `Date`. `new Date('2026-11-26')` se interpreta como medianoche
UTC y en un equipo de México se vería como el 25.

## Tablas

### `pkg_packages`

| Campo | Qué guarda |
|---|---|
| `tracking` / `tracking_key` | La guía tal como se escribió, y normalizada (solo A–Z y 0–9) para detectar duplicados |
| `carrier_code` / `carrier_other` | Paquetería del catálogo; el nombre escrito a mano cuando es `OTRA` |
| `delivery_mode` | `DOMICILIO`, `OCURRE` (oficina de la paquetería) u `OFICINA` (de HONOR) |
| `recipient_kind` / `recipient_key` | `PERSONA` contra `hc_people.person_key`, u `OFICINA` contra `pkg_offices.code` |
| `recipient_name` / `_role` / `_region` | **Copia** de esos datos al dar de alta |
| `origin_city` / `_state`, `dest_city` / `_state` | Origen y destino |
| `dest_place` | Dirección, sucursal donde ocurre u oficina, según el modo |
| `shipped_date`, `eta_date` | Fecha de envío y llegada aproximada (captura manual, un solo día) |
| `status` | Ver abajo |
| `contents`, `notes` | Qué va en el paquete y observaciones, en texto libre |
| `delivered_at` | Se pone al marcar entregado y se limpia si la guía vuelve a abrirse |
| `created_by/at`, `updated_by/at`, `deleted_at` | Trazabilidad y baja lógica |

**El destinatario se guarda doble a propósito.** La llave enlaza con su ficha
en *Datos del personal*; el nombre, rol y región copiados hacen que el paquete
siga diciendo a quién iba aunque esa persona salga de la plantilla. Al editar
una guía cuyo destinatario ya no existe en la carga vigente, se conservan los
datos originales en vez de fallar.

### `pkg_events`

Una fila por movimiento: `alta`, `estado`, `datos` o `baja`, con quién y
cuándo, y un detalle legible (`llegada estimada: 2026-11-29 -> 2026-12-02`).

Es el enganche de las notificaciones: permite preguntar **qué cambió desde tal
momento** sin comparar dos estados completos.

### `pkg_carriers` y `pkg_offices`

Catálogos. Se siembran una sola vez (solo si la tabla está vacía), así que un
reinicio nunca pisa lo que se haya cambiado después.

## Estados

| Clave | Etiqueta | Abierto | Tono |
|---|---|---|---|
| `EN_TRANSITO` | En tránsito | sí | neutral |
| `EN_SUCURSAL` | En sucursal, listo para recoger | sí | advertencia |
| `RETRASADO` | Retrasado | sí | serio |
| `INCIDENCIA` | Con incidencia | sí | crítico |
| `ENTREGADO` | Entregado | no | bueno |
| `CANCELADO` | Cancelado | no | neutral |

Una guía abierta cuya fecha ya pasó se marca además con la etiqueta **pasada
de fecha**: palabra y color, no solo color, porque en papel y en pantallas sin
color el rojo no sobrevive.

## Paqueterías y sus ligas de rastreo

Se siembran trece, con DHL primero. `track_url` guarda la página pública de
rastreo **sin el número de guía dentro**: las ligas con el número cambian sin
aviso y una liga rota es peor que ninguna. El sitio abre la página y deja la
guía en el portapapeles.

Cuatro apuntan a la página de rastreo (DHL, Estafeta, FedEx, UPS). Del resto
se guarda la página principal, que no puede dar 404. Cambiar cualquiera es una
línea de SQL:

```sql
UPDATE pkg_carriers SET track_url = 'https://…' WHERE code = 'REDPACK';
```

Agregar una oficina de HONOR:

```sql
INSERT INTO pkg_offices (code, name, city, state, sort)
VALUES ('CDMX', 'Oficina HONOR Ciudad de Mexico', 'CIUDAD DE MEXICO', 'CIUDAD DE MEXICO', 20);
```

## API

Todo bajo `/api/paqueteria`. Lectura con cualquier sesión; escritura con
editor o administrador; baja solo administrador.

| Método y ruta | Qué hace |
|---|---|
| `GET /catalogs` | Todo lo que el formulario necesita en una sola petición: paqueterías, oficinas, mandos medios, ciudades, estados y modos de entrega |
| `GET /` | Lista con filtros (`scope`, `status`, `carrier`, `region`, `recipient`, `deliveryMode`, `search`) |
| `GET /agenda` | Lo mismo agrupado por cercanía de llegada |
| `GET /summary` | Los cuatro indicadores |
| `GET /:id` | Ficha con la bitácora completa |
| `POST /` | Alta. Responde **409** con `code: DUPLICADO` si esa guía ya existe en la misma paquetería; reenviar con `force: true` la registra igual |
| `PATCH /:id` | Edición parcial; solo los campos que cambian entran a la bitácora |
| `POST /:id/status` | Cambio rápido de estado, con nota opcional |
| `DELETE /:id` | Baja lógica |
| `GET /export/paquetes.csv` | Exportación |

Los destinatarios salen de la plantilla vigente filtrando los roles del grupo
`mando` (supervisor mix, supervisor, city manager, trainer y field rep). Si
todavía no hay plantilla cargada se devuelven solo las oficinas, para que la
sección funcione desde el primer día.

## Lo que queda listo para notificaciones

Sin construirlas todavía:

- `eta_date` como fecha simple, sin hora ni zona.
- El conjunto de estados cerrado, con `open` marcando cuáles siguen vivos.
- `pkg_events` con marca de tiempo, para preguntar qué cambió desde cuándo.
- El destinatario con llave estable hacia `hc_people`.
- `buildAgenda()`, que ya responde «qué llega hoy, mañana y esta semana».

Un proceso que corra cada mañana, pregunte la agenda y mande el aviso no
necesita tocar el modelo.

## Lo que no hace

No se conecta a las APIs de las paqueterías para rastrear automáticamente:
cada una exige cuenta y credenciales propias, y la red del servidor está
restringida a una lista de hosts. La captura es manual, con la liga al rastreo
oficial a un clic.
