# Estructura del archivo de plantilla

Documentación de cómo el sistema lee `HC_R123.xlsb`, el archivo de personal que
la empresa actualiza dos veces por semana. Es independiente del reporte de
ventas: cubre más cadenas, otros roles y otro ritmo de actualización.

## Formato

El archivo es **`.xlsb`** (binario de Excel), que la librería del reporte de
ventas no abre. Se lee con **SheetJS**, fijado en `server/package.json` a la
versión del sitio oficial del proyecto:

```
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

Se toma de ahí y no de npm porque la versión publicada en npm quedó en 0.18.5,
con dos avisos de seguridad sin corregir. El `package-lock.json` guarda el hash
de integridad, así que la descarga se verifica en cada instalación.

> **Al desplegar**, el servidor necesita alcanzar `cdn.sheetjs.com`. Si la red
> lo bloquea, `npm ci` falla al instalar esa dependencia.

También se aceptan `.xlsx` y `.xlsm` por si algún día exportan en otro formato.

## Principio de lectura

Igual que el parser de ventas, **no usa posiciones fijas de columna**:

1. **La fila de encabezado** de `FF` se localiza por sus etiquetas ancla
   (`Customer`, `RG`, `NAME`, `ID`), hoy en la fila 7.
2. **Los bloques de rol** se detectan por la columna `Tipo de piso`, con la que
   todos empiezan; el nombre del rol sale de la fila de grupo de arriba.
3. **La columna del nombre** dentro de cada bloque se elige por contenido y no
   solo por encabezado, porque varias columnas comparten el texto del rol: una
   trae el nombre y otra una marca numérica.

Así el archivo puede crecer en roles o moverse de columnas sin romper la lectura.

## Hojas que se leen

De las once hojas del libro solo tres son fuente de datos; el resto
(`Pivot Promotores`, `SUMMARY`, `Pivot MM`, `Hoja1`–`Hoja4`, `Sheet1`) son
tablas dinámicas que el propio Excel recalcula.

| Hoja | Qué aporta |
|---|---|
| `FF` | **Matriz tienda × rol.** Una fila por punto de venta con sus datos (canal, región, estado, ciudad, clasificación, ID `APSMX`, nombre, dirección, Tier) y once bloques de rol, cada uno con tipo de piso, estatus, ID HONOR, ID de agencia y nombre. |
| `INGRESO` | Nombre del promotor y fecha de ingreso. Las filas `VACANCY` se omiten; sin fecha, el campo queda vacío. |
| `MM` | Mandos medios: región, agencia, posición, estatus, ID HONOR, ID SP, nombre, estado y ciudad. |

### Roles de la hoja FF

El archivo declara once bloques. Hoy vienen poblados cinco, pero los seis
vacíos se leen igual y entrarán solos el día que los llenen.

| Rol | Poblado en el archivo de nov-2026 |
|---|---|
| Fixed promoter | sí — 191 plazas, 151 personas, 17 vacantes |
| Supervisor mix | sí — 327 plazas, 14 personas, 20 vacantes |
| City manager | sí — 442 plazas, 5 personas |
| Trainer | sí — 390 plazas, 5 personas |
| Field rep | sí — 110 plazas, 6 personas |
| Double promoter, Lobo promoter, Supervisor, Merchandiser, Temporal promoter, ATT PRM promoter | la estructura existe, sin datos |

## Identidad de una persona

El **ID HONOR** (`bw0134360`) es la llave, porque es mucho más estable que el
nombre. Pero solo se usa cuando la correspondencia es uno a uno en los dos
sentidos:

- un ID con **dos nombres** es un copiado que no se actualizó;
- un nombre con **dos IDs** partiría a la persona en dos.

En cualquiera de los dos casos esa persona se identifica por nombre y el caso
aparece como **aviso en la pantalla de carga**, para que se corrija en el
origen. El archivo de noviembre de 2026 trae un caso: el ID `cw0156338`
aparece con dos nombres.

El cruce entre `FF` e `INGRESO` es por nombre normalizado (sin acentos, sin
dobles espacios), que es lo único que publica la hoja `INGRESO`. En el archivo
de noviembre coinciden las 151 personas de ambas hojas.

## Detección de cambios

Cada carga se guarda completa e inmutable. Al subir una nueva, se compara
contra la anterior **por persona** y se registran los movimientos:

| Movimiento | Cuándo |
|---|---|
| Alta | la persona no estaba en la carga anterior |
| Baja | estaba y ya no aparece |
| Cambio de tienda | cambió alguna de sus plazas, con cuál dejó y cuál tomó |
| Cambio de rol | cambió el conjunto de roles que cubre |
| Dato actualizado | se llenó un dato que faltaba, como la fecha de ingreso |
| Vacante abierta / cubierta | una plaza pasó a `VACANCY` o dejó de serlo |

El historial se acumula carga tras carga, así que con el tiempo queda la
rotación real sin tener que guardar los archivos.

## Alcance frente al reporte de ventas

Son dos universos distintos y conviene no confundirlos. El archivo de plantilla
cubre **1,079 tiendas en 14 cadenas** —incluidas Bodega Aurrera, Walmart, Sams,
Suburbia, Sanborns, Telmex y Office Depot, que no están en el reporte de
ventas— contra las ~195 plazas del reporte diario.

El ID HONOR y la fecha de ingreso quedan guardados pensando en cruzar más
adelante antigüedad contra desempeño de venta, y en atribuir el sell-out a la
cadena de mando real en lugar de a nombres sueltos.
