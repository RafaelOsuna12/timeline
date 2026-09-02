/**
 * Piezas comunes de los graficos (Recharts).
 *
 * Reglas aplicadas en todos ellos:
 *   - un solo eje de valor (nunca dos escalas en un mismo plot);
 *   - rejilla y ejes como lineas finas y solidas, en tono recesivo;
 *   - marcas delgadas, capa de hover siempre presente;
 *   - los textos usan tinta, no el color de la serie.
 */
import { Tooltip } from 'recharts';

export const AXIS_STYLE = {
  fontSize: 11,
  fill: 'var(--text-muted)',
};

export const gridProps = {
  stroke: 'var(--grid)',
  strokeDasharray: '0',
  vertical: false,
};

export const axisProps = {
  tick: AXIS_STYLE,
  tickLine: false,
  axisLine: { stroke: 'var(--axis)' },
};

/**
 * Recorta las etiquetas del eje de categorias. Los nombres completos de
 * promotores y supervisores se encimarian; el valor integro sigue disponible
 * en el tooltip y en la tabla que acompaña a cada grafico.
 */
export function truncateTick(value, max = 24) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Tooltip con el mismo formato en todos los graficos. */
export function ChartTooltip({ active, payload, label, title, format = (v) => v, extra }) {
  if (!active || !payload || !payload.length) return null;
  const rows = payload.filter((p) => p.value !== null && p.value !== undefined);
  if (!rows.length) return null;
  return (
    <div className="tooltip">
      <div className="tooltip__title">{title ? title(label, payload) : label}</div>
      {rows.map((row) => (
        <div className="tooltip__row" key={`${row.dataKey}-${row.name}`}>
          <span className="tooltip__key">
            <span
              className="legend__swatch"
              style={{ background: row.color || row.stroke || row.fill, width: 10, height: 10, borderRadius: 2 }}
              aria-hidden="true"
            />
            {row.name}
          </span>
          <span className="tooltip__val">{format(row.value, row)}</span>
        </div>
      ))}
      {extra && <div className="tooltip__row muted small">{extra(label, payload)}</div>}
    </div>
  );
}

/** Tooltip con cursor de cruz para series temporales. */
export function LineTooltip(props) {
  return (
    <Tooltip
      cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
      wrapperStyle={{ outline: 'none' }}
      content={<ChartTooltip {...props} />}
    />
  );
}

/** Tooltip con realce del area de la barra. */
export function BarTooltip(props) {
  return (
    <Tooltip
      cursor={{ fill: 'var(--wash)' }}
      wrapperStyle={{ outline: 'none' }}
      content={<ChartTooltip {...props} />}
    />
  );
}

/**
 * Leyenda propia (la de Recharts no permite el estilo de trazo discontinuo
 * que distingue la proyeccion de lo observado).
 */
export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((item) => (
        <span className="legend__item" key={item.label}>
          <span
            className={`legend__swatch${item.dashed ? ' legend__swatch--dashed' : ''}${
              item.square ? ' legend__swatch--square' : ''
            }`}
            style={item.dashed ? { color: item.color } : { background: item.color }}
            aria-hidden="true"
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
