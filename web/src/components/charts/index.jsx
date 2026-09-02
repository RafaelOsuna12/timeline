/** Graficos del tablero. */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { BarTooltip, LineTooltip, Legend, axisProps, gridProps, truncateTick } from './primitives.jsx';
import { d1, n, pct, sequentialStep } from '../../utils/format.js';

/**
 * Curva de avance: acumulado real contra la curva de target y la proyeccion
 * de cierre. Una sola escala (piezas). La proyeccion va discontinua porque
 * todavia no ha ocurrido.
 */
export function AdvanceCurve({ daily, target, cutoffDay, height = 300 }) {
  return (
    <>
      <Legend
        items={[
          { label: 'Acumulado real', color: 'var(--series-1)' },
          { label: 'Proyeccion de cierre', color: 'var(--series-1)', dashed: true },
          { label: 'Curva de target', color: 'var(--text-muted)' },
        ]}
      />
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={daily} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="day" {...axisProps} interval={daily.length > 20 ? 2 : 0} />
          <YAxis {...axisProps} width={52} tickFormatter={(v) => n(v)} />
          {target > 0 && (
            <ReferenceLine
              y={target}
              stroke="var(--status-good)"
              strokeWidth={1.5}
              label={{ value: `Target ${n(target)}`, position: 'insideTopRight', fill: 'var(--text-secondary)', fontSize: 11 }}
            />
          )}
          {cutoffDay < daily.length && (
            <ReferenceLine
              x={cutoffDay}
              stroke="var(--axis)"
              strokeWidth={1}
              label={{ value: 'Corte', position: 'top', fill: 'var(--text-muted)', fontSize: 10 }}
            />
          )}
          <Line
            type="monotone"
            dataKey="targetCurve"
            name="Curva de target"
            stroke="var(--text-muted)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="projection"
            name="Proyeccion de cierre"
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="cumulative"
            name="Acumulado real"
            stroke="var(--series-1)"
            strokeWidth={2.5}
            dot={false}
            isAnimationActive={false}
          />
          <LineTooltip title={(day) => `Dia ${day}`} format={(v) => n(v)} />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

/**
 * Sell-out diario con la media movil de 7 dias. Ambas medidas estan en piezas,
 * asi que comparten eje.
 */
export function DailyBars({ daily, height = 260, showAverage = true }) {
  const data = daily.map((d, i) => {
    const window = daily.slice(Math.max(0, i - 6), i + 1).filter((x) => !x.isFuture);
    const avg = window.length ? window.reduce((a, b) => a + b.so, 0) / window.length : null;
    return { ...d, movingAverage: d.isFuture ? null : avg };
  });

  return (
    <>
      <Legend
        items={[
          { label: 'Sell-out del dia', color: 'var(--series-1)', square: true },
          ...(showAverage ? [{ label: 'Promedio movil 7 dias', color: 'var(--series-2)' }] : []),
        ]}
      />
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="day" {...axisProps} interval={data.length > 20 ? 2 : 0} />
          <YAxis {...axisProps} width={44} tickFormatter={(v) => n(v)} />
          <Bar dataKey="so" name="Sell-out del dia" radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={22}>
            {data.map((d) => (
              <Cell key={d.day} fill={d.isFuture ? 'var(--wash)' : 'var(--series-1)'} />
            ))}
          </Bar>
          {showAverage && (
            <Line
              type="monotone"
              dataKey="movingAverage"
              name="Promedio movil 7 dias"
              stroke="var(--series-2)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          )}
          <BarTooltip
            title={(day, payload) => {
              const row = payload?.[0]?.payload;
              return `Dia ${day}${row?.weekday ? ` · ${row.weekday}` : ''}`;
            }}
            format={(v) => n(v)}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

/**
 * Ranking horizontal de una sola medida: una serie, un color. El semaforo del
 * estado va en la tabla y en la pastilla, nunca sustituyendo al color de serie.
 */
export function RankingBars({ data, dataKey = 'value', labelKey = 'name', height, format = n, reference, referenceLabel }) {
  const chartHeight = height || Math.max(150, data.length * 34 + 36);
  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 46, bottom: 4, left: 4 }}>
        <CartesianGrid {...gridProps} horizontal={false} vertical />
        <XAxis type="number" {...axisProps} tickFormatter={format} />
        <YAxis type="category" dataKey={labelKey} {...axisProps} width={170} tickFormatter={(v) => truncateTick(v)} />
        {reference !== undefined && (
          <ReferenceLine
            x={reference}
            stroke="var(--status-good)"
            strokeWidth={1.5}
            label={{ value: referenceLabel, position: 'top', fill: 'var(--text-secondary)', fontSize: 10 }}
          />
        )}
        <Bar dataKey={dataKey} name="Valor" fill="var(--series-1)" radius={[0, 4, 4, 0]} isAnimationActive={false} maxBarSize={18} />
        <BarTooltip format={format} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Perfil por dia de la semana: categorias ordenadas, una sola serie. */
export function WeekdayProfile({ data, height = 190 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="weekday" {...axisProps} />
        <YAxis {...axisProps} width={40} tickFormatter={(v) => n(v)} />
        <Bar dataKey="average" name="Promedio por dia" fill="var(--series-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={38} />
        <BarTooltip format={(v) => `${d1(v)} pzs`} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Comparativo de dos periodos de carga (avance entre snapshots). */
export function DeltaBars({ data, height, format = n }) {
  const chartHeight = height || Math.max(150, data.length * 34 + 36);
  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 30, bottom: 4, left: 4 }}>
        <CartesianGrid {...gridProps} horizontal={false} vertical />
        <XAxis type="number" {...axisProps} tickFormatter={format} />
        <YAxis type="category" dataKey="name" {...axisProps} width={180} tickFormatter={(v) => truncateTick(v)} />
        <ReferenceLine x={0} stroke="var(--axis)" strokeWidth={1} />
        <Bar dataKey="delta" name="Avance" radius={[0, 4, 4, 0]} isAnimationActive={false} maxBarSize={18}>
          {data.map((row) => (
            <Cell key={row.key} fill={row.delta >= 0 ? 'var(--series-1)' : 'var(--series-8)'} />
          ))}
        </Bar>
        <BarTooltip format={format} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Mapa de calor de sell-out por promotor y dia.
 * Escala secuencial de un solo tono; las ausencias se marcan aparte para que
 * "no asistio" no se confunda con "vendio cero".
 */
export function Heatmap({ rows, days, cutoffDay, max, onSelect }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: Math.max(560, days * 17 + 200) }}>
        <div
          className="heat"
          style={{ gridTemplateColumns: `200px repeat(${days}, minmax(0, 1fr))`, alignItems: 'center' }}
        >
          <span className="heat__label muted" style={{ fontSize: 10 }}>
            Promotor / dia
          </span>
          {Array.from({ length: days }, (_, i) => (
            <span key={`h-${i}`} className="muted" style={{ fontSize: 9, textAlign: 'center' }}>
              {(i + 1) % 2 === 1 ? i + 1 : ''}
            </span>
          ))}
          {rows.map((row) => (
            <HeatRow key={row.key} row={row} days={days} cutoffDay={cutoffDay} max={max} onSelect={onSelect} />
          ))}
        </div>
      </div>
    </div>
  );
}

function HeatRow({ row, days, cutoffDay, max, onSelect }) {
  return (
    <>
      <button
        type="button"
        className="heat__label"
        title={`${row.name} · ${row.store}`}
        onClick={onSelect ? () => onSelect(row) : undefined}
        style={{
          background: 'none',
          border: 0,
          textAlign: 'left',
          cursor: onSelect ? 'pointer' : 'default',
          padding: 0,
        }}
      >
        {row.name}
      </button>
      {Array.from({ length: days }, (_, i) => {
        const future = i + 1 > cutoffDay;
        const present = row.attendance[i] > 0;
        const value = row.so[i] || 0;
        let background = 'var(--wash)';
        let title = `Dia ${i + 1}: sin asistencia registrada`;
        if (future) {
          background = 'transparent';
          title = `Dia ${i + 1}: aun no ocurre`;
        } else if (present && value > 0) {
          background = sequentialStep(value, max) || 'var(--seq-100)';
          title = `Dia ${i + 1}: ${value} pzs`;
        } else if (present) {
          background = 'var(--surface-2)';
          title = `Dia ${i + 1}: asistio sin venta`;
        }
        return (
          <span
            key={i}
            className="heat__cell"
            title={`${row.name} — ${title}`}
            style={{
              background,
              border: present && !future ? '1px solid var(--border)' : '1px solid transparent',
            }}
          />
        );
      })}
    </>
  );
}

/** Escala de referencia del mapa de calor. */
export function HeatLegend({ max }) {
  return (
    <div className="legend" style={{ alignItems: 'center' }}>
      <span className="legend__item">
        <span className="legend__swatch legend__swatch--square" style={{ background: 'var(--wash)' }} aria-hidden="true" />
        Sin asistencia
      </span>
      <span className="legend__item">
        <span
          className="legend__swatch legend__swatch--square"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
          aria-hidden="true"
        />
        Asistio sin venta
      </span>
      <span className="legend__item" style={{ gap: 4 }}>
        1
        {['var(--seq-100)', 'var(--seq-200)', 'var(--seq-300)', 'var(--seq-400)', 'var(--seq-500)', 'var(--seq-600)', 'var(--seq-700)'].map(
          (c) => (
            <span key={c} className="legend__swatch legend__swatch--square" style={{ background: c }} aria-hidden="true" />
          )
        )}
        {n(max)} pzs
      </span>
    </div>
  );
}

/** Barra de progreso comparativa usada en las listas de mezcla de modelos. */
export function ShareBars({ data, height, format = n }) {
  const chartHeight = height || Math.max(150, data.length * 34 + 34);
  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 52, bottom: 4, left: 4 }}>
        <CartesianGrid {...gridProps} horizontal={false} vertical />
        <XAxis type="number" {...axisProps} tickFormatter={format} />
        <YAxis type="category" dataKey="model" {...axisProps} width={150} tickFormatter={(v) => truncateTick(v, 20)} />
        <Bar dataKey="qty" name="Piezas" fill="var(--series-1)" radius={[0, 4, 4, 0]} isAnimationActive={false} maxBarSize={20} />
        <BarTooltip
          format={(v, row) => `${n(v)} pzs${row?.payload?.share ? ` · ${pct(row.payload.share)}` : ''}`}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
