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

Los nombres de las hojas cambian de un mes a otro, así que se localizan por
**patrón** y no por nombre exacto: la hoja maestra pasó de
`1.Daily_Retail_FF_SO_Target` a `1.DailySO_Retail_FF_Target` —con el `SO` en
otro lugar— y ambas formas se leen igual.

| Hoja | Qué aporta |
|---|---|
| `1.DailySO_Retail_FF_Target` | **Base maestra.** Un renglón por promotor con canal, región, tienda, supervisor, CM, tipo de plaza, targets mensuales y las tres series diarias (sell-out de modelos foco, asistencia y días en cero). |
| `2.Daily_SORetail_FF-All_Series` | Sell-out diario de **todas las series**, no solo los modelos foco. |
| `3.Monthly_SO_FOCUS_Models` | Mezcla mensual por promotor: piezas de cada modelo foco más IOT. |
| `4.Daily_Retail_FF_SO_IOT` | Sell-out diario de accesorios y wearables (IOT). **Dejó de venir a partir de octubre de 2026**: cuando falta, el tablero omite el indicador en vez de mostrar un cero que se leería como "no vendió". |
| `00.BY_Supervisors&CM` | Estructura de equipos: bloques por región con renglones `SP` (supervisor) y `CM` (city manager), sus FF a cargo y sus series diarias. |
| `Daily_SO_*` | Serie diaria por promotor de cada modelo con seguimiento. Conviven dos formas: la antigua `Daily_SO_Watch6_Model` y la nueva, numerada y sin sufijo (`4.Daily_SO_X5D`, `5.Daily_SO_H600_Elite`, `6.Daily_SO_X6e`, `7.Daily_SO_X7e`). Son las que alimentan la curva de adopción. |
| `SO_Model` | Sell-out de productos clave por canal y modelo, con número de tiendas y productividad. |
| `X8D`, `M8L` | Desglose del modelo por versión de operador y por color. |

Las hojas `DB_from_Retail_*`, `DB_from_x6c_*`, `so-qty`, `so-imei`, `pv_mod` y
`FF-*W##-DATA` son volcados intermedios que alimentan las fórmulas del libro; el
sistema no las necesita porque lee los resultados ya calculados.

Tampoco se leen, por ahora: `INV_Launch_WK##` (inventario por tienda de los
modelos del lanzamiento), los padrones semanales `FF-LW##` / `FF-VW##` (plaza
por plaza con estatus `COVERED`/`VACANCY`, útiles para medir rotación),
`Watch6_Model (0 Sales)` —que el tablero puede deducir solo— y
`0.Daily_Retail_H200`, que cubre apenas 14 promotores.

Los modelos de la mezcla mensual se detectan por su encabezado (`HONOR …`), así
que los que se agregaron en octubre —`HONOR X6e`, `HONOR X7e` y
`HONOR 600 Elite`— entraron sin tocar el código. El canal `ELEKTRA`, también
nuevo, sí se registró explícitamente.

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

Cada fila es una **plaza**: tienda + asesor. Un mismo promotor puede ocupar dos
plazas (cobertura doble), así que la clave de la fila es *tienda + nombre*, pero
para contar personas y días trabajados esas filas se agrupan por asesor —ver
[Promotores con más de una tienda](METRICAS.md#promotores-con-más-de-una-tienda)—.

La columna `DOUBLE ADVISOR` existe en el archivo pero viene en cero para todas
las filas, así que no se usa: la cobertura doble se detecta por el nombre
repetido.

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
