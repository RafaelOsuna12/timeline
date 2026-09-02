# Estructura del archivo de Excel

Documentación de cómo el sistema lee `R123_DailySO_Models_AAAAMMDD_*.xlsx`.
Sirve para entender qué se aprovecha de cada hoja y qué cambios del archivo
podrían romper la lectura.

## Principio de lectura

El parser **no usa posiciones fijas de columna**. En cada hoja localiza:

1. **La fila de encabezado**, buscando etiquetas ancla (`CHANNEL`, `REGION`,
   `STORE NAME`, `SALES ADVISOR`, `Position`/`NAME`, `Channel`/`Model`…).
2. **La fila de fechas**, que es la fila del encabezado con más celdas de tipo
   fecha real. Las celdas con formato de fecha pero contenido no convertible
   (por ejemplo la fila `Sat / Sun / Mon`) se descartan.
3. **Los bloques de días**: rachas consecutivas de columnas con fecha. En las
   hojas diarias el orden es siempre el mismo:
   `[Sell-out] [Asistencia] [Cero venta]`.

Gracias a esto el mismo código lee agosto (31 días) o febrero (28) sin ajustes,
y tolera que se inserten o muevan columnas de target.

Del bloque de días solo se conservan las fechas que pertenecen al mes del
reporte: las hojas incluyen los primeros días del mes siguiente como colchón y
se descartan.

## Hojas que se leen

| Hoja | Qué aporta |
|---|---|
| `1.Daily_Retail_FF_SO_Target` | **Base maestra.** Un renglón por promotor con canal, región, tienda, supervisor, CM, tipo de plaza, targets mensuales y las tres series diarias (sell-out de modelos foco, asistencia y días en cero). |
| `2.Daily_SORetail_FF-All_Series` | Sell-out diario de **todas las series**, no solo los modelos foco. |
| `3.Monthly_SO_FOCUS_Models` | Mezcla mensual por promotor: piezas de cada modelo foco más IOT. |
| `4.Daily_Retail_FF_SO_IOT` | Sell-out diario de accesorios y wearables (IOT). |
| `00.BY_Supervisors&CM` | Estructura de equipos: bloques por región con renglones `SP` (supervisor) y `CM` (city manager), sus FF a cargo y sus series diarias. |
| `Daily_SO_*_Model` | Serie diaria por promotor de cada modelo foco (`Watch6`, `M8L`, `H600`, `H600e`, `X5d`…). |
| `SO_Model` | Sell-out de productos clave por canal y modelo, con número de tiendas y productividad. |
| `X8D`, `M8L` | Desglose del modelo por versión de operador y por color. |

Las hojas `DB_from_Retail_*`, `so-qty`, `so-imei`, `pv_mod` y las `FF-*W##` son
volcados intermedios que alimentan las fórmulas del libro; el sistema no las
necesita porque lee los resultados ya calculados.

## Columnas clave de la hoja base

En `1.Daily_Retail_FF_SO_Target` (fila de encabezado con `CHANNEL`):

| Etiqueta buscada | Uso |
|---|---|
| `CHANNEL` | Canal (TELCEL, COPPEL, LIVERPOOL, SEARS, AT&T, MOVISTAR) |
| `REGION` | R1, R2, R3. Un `0` se interpreta como plaza sin región (OFFLINE) |
| `STORE NAME` | Tienda |
| `SALES ADVISOR` | Promotor |
| `SUPERVISOR MIX` | Supervisor a cargo |
| `CM` | City manager |
| `BASE/SUPPORT` | Tipo de plaza: BASE, SUPPORT u OFFLINE |
| `…INITIAL TARGET` / `…AJUST TARGET` | Se toma la **última** columna de cada tipo antes del primer día: es el target vigente del mes |
| `Target HQ` | Objetivo oficial contra el que se mide el ACH% |
| `SO (Tgt Models)` | Sell-out acumulado de modelos foco |
| `TTL SO ALL Models` | Sell-out acumulado de todas las series |

La clave única de un promotor es **tienda + nombre**, porque un mismo asesor
puede aparecer en dos tiendas distintas (cobertura doble).

## Día de corte

El sistema calcula el **día de corte** como el último día del mes con actividad
registrada (sell-out o asistencia de cualquier promotor). Ese día es la
referencia para el avance y para la proyección; no se toma de ninguna celda del
archivo, así que un cambio de formato no lo afecta.

## Cargas repetidas

Cada archivo procesado se guarda como una **versión independiente** (snapshot).
Nada se sobrescribe:

- La versión vigente de un periodo es la de mayor día de corte.
- Si se sube dos veces el mismo archivo (mismo contenido byte a byte), el
  sistema lo detecta y conserva la carga existente en lugar de duplicarla.
- Conservar el historial es lo que permite la vista **Avance entre cargas**.

## Si el archivo cambia de estructura

El parser reporta avisos (no errores) cuando no encuentra una hoja secundaria;
el tablero sigue funcionando con lo que sí pudo leer, y los avisos aparecen en
la pantalla de carga y en el historial.

Solo falla por completo si no existe la hoja `1.Daily_Retail_FF_SO_Target` o si
en ella no se detectan fechas: sin eso no hay periodo ni promotores que medir.

Cambios que **no** afectan la lectura:

- Insertar, mover o renombrar columnas de target.
- Cambiar el número de días del mes.
- Agregar o quitar promotores, tiendas, supervisores o regiones.
- Agregar modelos nuevos a `3.Monthly_SO_FOCUS_Models` (aparecen solos en la
  mezcla) o nuevas hojas `Daily_SO_<modelo>_Model`.

Cambios que **sí** requieren ajustar el parser:

- Renombrar las hojas principales (los patrones están en
  `server/src/parser/index.js`, constante `SHEET_PATTERNS`).
- Cambiar las etiquetas ancla del encabezado (`SALES ADVISOR`, `SUPERVISOR MIX`,
  `Target HQ`…).
- Alterar el orden de los bloques diarios (sell-out, asistencia, cero venta).
