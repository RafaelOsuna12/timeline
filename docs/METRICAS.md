# Métricas y proyecciones

Cómo se calcula cada número del tablero. Todas las vistas —compañía, región,
CM, supervisor, promotor, canal y tienda— usan las mismas funciones, así que un
mismo indicador da el mismo resultado en cualquier nivel de la jerarquía.

## Conceptos base

| Término | Definición |
|---|---|
| **Día de corte** | Último día del mes con información en el archivo. |
| **MTD** | Acumulado del mes hasta el día de corte. |
| **Target** | Objetivo HQ del mes (columna `Target HQ`), sumado desde el promotor hacia arriba. |
| **Modelos foco** | Los modelos con target: Watch 6, Magic8 Lite, 600, 600e, X5d, más IOT. |
| **Todas las series** | Sell-out completo del portafolio, incluyendo modelos sin target. |

## Indicadores de avance

```
ACH%              = MTD / Target
Avance de tiempo  = día de corte / días del mes
Ritmo (pace)      = ACH% / Avance de tiempo
Gap               = Target − MTD
Ritmo diario      = MTD / día de corte
Requerido diario  = (Target − MTD) / días restantes
Índice de esfuerzo = Requerido diario / Ritmo diario
```

El **índice de esfuerzo** responde de un vistazo "¿cuánto más rápido hay que
ir?". Un 1.5 significa que hay que vender 50 % más por día de lo que se ha
venido vendiendo.

La barra de los indicadores muestra el ACH% y una marca vertical en el avance
de tiempo: si la barra no llega a la marca, se va por detrás del calendario.

## Proyección de cierre

Se calculan tres escenarios y se presenta el estacional como base.

### Estacional (base)

Para cada día ya transcurrido se agrupa el sell-out por día de la semana y se
obtiene el promedio de cada uno. Los días que faltan se estiman con el promedio
del día de la semana que les corresponde:

```
Proyección = MTD + Σ (promedio del día de la semana de cada día restante)
```

Es el escenario base porque en retail el fin de semana concentra una parte
desproporcionada del sell-out. Con un promedio simple, la proyección sube o baja
solo por el día en que cae el corte, sin que haya cambiado nada del negocio.

### Ritmo simple

```
Proyección = MTD + (MTD / día de corte) × días restantes
```

### Tendencia reciente

```
Proyección = MTD + (promedio de los últimos 7 días) × días restantes
```

Útil cuando hubo un cambio reciente —una campaña, una vacante cubierta— que el
promedio de todo el mes todavía diluye.

### Precisión observada

Validado contra el cierre real de agosto de 2026 (5,640 piezas):

| Corte | Proyección estacional | Diferencia contra el cierre real |
|---|---|---|
| Día 10 | 5,552 | −1.6 % |
| Día 18 | 5,466 | −3.1 % |
| Día 20 | 5,423 | −3.8 % |
| Día 25 | 5,493 | −2.6 % |

La proyección quedó por debajo porque agosto tuvo una última semana fuerte. Es
el comportamiento esperado: el modelo no anticipa cierres de mes atípicos, los
refleja conforme ocurren.

## Clasificación de desempeño

El **60 % es el mínimo requerido**: por debajo de esa línea el resultado está
fuera de meta, sin matices. De ahí hacia arriba hay tres escalones antes del
objetivo, para distinguir a quien apenas cumple de quien está a un paso.

| Estatus | Rango | Color |
|---|---|---|
| En meta | 100 % o más | verde, punto lleno |
| Ideal | 90 % a 99 % | verde, punto hueco |
| Regular | 70 % a 89 % | ámbar |
| Mínimo | 60 % a 69 % | naranja |
| Fuera de meta | menos de 60 % | rojo |
| Sin target | sin objetivo asignado | gris |

Se evalúa sobre el **cierre proyectado**, no sobre el avance del día. La razón
es que a mitad de mes el acumulado siempre es bajo por construcción: clasificar
por avance marcaría a todo el equipo fuera de meta el día 10, cuando en realidad
va en ritmo. Al cierre del mes ambos valores coinciden.

"En meta" e "Ideal" comparten el verde porque solo hay cuatro colores reservados
para estado; se distinguen por la etiqueta y por el punto lleno o hueco, de modo
que la diferencia nunca depende únicamente del color.

Las mismas bandas tiñen la columna ACH% de las tablas, así que un porcentaje y
su pastilla siempre cuentan lo mismo.

### Alertas

- **Regiones**: se avisa de cualquiera que no proyecte el 100 %, con gravedad
  según la banda. Son tres, así que la lista no se satura.
- **Supervisores**: solo por debajo del 70 % (bandas Mínimo y Fuera de meta).
  Con el umbral en 90 % aparecerían casi todos y la lista dejaría de señalar
  nada.
- **Promotores**: sin venta alguna, con la mitad o más de sus días en cero, o
  sin asistencia registrada en el mes.

## Curva de target

La curva contra la que se compara el acumulado no es una recta. El target se
reparte entre los días del mes con el mismo peso por día de la semana que usa la
proyección, de modo que la comparación sea justa: en un fin de semana la curva
sube más, igual que las ventas.

## Asistencia y días en cero

```
Cobertura de piso  = días asistidos / (promotores × días del corte)
Días en cero       = días con asistencia registrada pero sin venta de modelos foco
% en cero          = días en cero / días asistidos
Productividad      = MTD / días asistidos
```

La distinción importa: un equipo puede no llegar por **falta de cobertura**
(nadie en piso) o por **falta de conversión** (en piso sin vender). El mapa de
calor separa ambos casos —celda gris para la ausencia, celda clara con borde
para el día en piso sin venta— porque la acción correctiva es distinta.

## Alcance de los totales

Por defecto se excluyen las plazas marcadas como **OFFLINE** (sin región
asignada), para que los totales del tablero cuadren con el reporte HQ. Se
pueden incluir con el parámetro `includeOffline=true` en la API.

El conteo de promotores del tablero incluye plazas BASE y SUPPORT, mientras que
la columna `FFs in charge` de la hoja de supervisores cuenta solo las BASE; por
eso ambos números pueden diferir en unas pocas unidades.

## Vista retrospectiva

El control **"Ver el mes al día N"** recalcula todo el tablero como se veía al
cierre de ese día, usando únicamente la información hasta esa fecha. Sirve para
dos cosas:

- Revisar la evolución del mes sin necesidad de haber guardado un archivo por día.
- Comprobar qué tan buena fue la proyección: se fija el corte en un día pasado y
  se compara la proyección de entonces con lo que realmente ocurrió.

## Avance entre cargas

Compara dos versiones del mismo periodo (por ejemplo la de hoy contra la de
ayer) y muestra, por región, CM, supervisor y canal:

- piezas ganadas entre ambas cargas,
- cambio en el ACH% expresado en puntos porcentuales,
- cambio en el cierre proyectado.

Un avance negativo no es un error: significa que la nueva carga corrigió
información de días anteriores.
