/** Piezas de interfaz reutilizables del tablero. */
import { useMemo, useState } from 'react';
import { STATUS_LABELS, STATUS_RANGES, achTone, statusTone, n, pct } from '../utils/format.js';

export function Card({ title, hint, actions, children, flush = false, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card__head">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {hint && <p className="card__hint">{hint}</p>}
          </div>
          {actions && <div className="row no-print">{actions}</div>}
        </header>
      )}
      <div className={`card__body${flush ? ' card__body--flush' : ''}`}>{children}</div>
    </section>
  );
}

/**
 * Tarjeta de indicador. El numero es el grafico: no se dibuja una barra de una
 * sola serie cuando basta la cifra.
 */
export function Kpi({ label, value, unit, meta, progress, marker, tone, compact = false }) {
  return (
    <article className="kpi">
      <span className="kpi__label">{label}</span>
      <span
        className="kpi__value"
        style={{
          ...(tone ? { color: `var(--status-${tone}-ink, var(--text-primary))` } : null),
          ...(compact ? { fontSize: 18, letterSpacing: '-0.01em', lineHeight: 1.25 } : null),
        }}
      >
        {value}
        {unit && <span className="kpi__unit">{unit}</span>}
      </span>
      {progress !== undefined && progress !== null && (
        <div
          className={`kpi__bar${marker !== undefined && marker !== null ? ' kpi__bar--marker' : ''}`}
          style={marker !== undefined && marker !== null ? { '--marker': `${Math.min(100, marker * 100)}%` } : undefined}
        >
          <span
            style={{
              width: `${Math.max(0, Math.min(100, progress * 100))}%`,
              background: tone ? `var(--status-${tone})` : 'var(--series-1)',
            }}
          />
        </div>
      )}
      {meta && <span className="kpi__meta">{meta}</span>}
    </article>
  );
}

export function StatusPill({ status }) {
  const tone = statusTone(status);
  // "Ideal" comparte el verde con "En meta": el punto hueco marca que aun no
  // se alcanza el objetivo, sin depender solo del color.
  const hollow = status === 'ideal';
  return (
    <span className={`pill pill--${tone}`} title={STATUS_RANGES[status] || ''}>
      <span className={`pill__dot${hollow ? ' pill__dot--hollow' : ''}`} aria-hidden="true" />
      {STATUS_LABELS[status] || status}
    </span>
  );
}

export function Spinner({ label }) {
  return (
    <div className="row" style={{ padding: '28px 8px', justifyContent: 'center' }}>
      <span className="spinner" aria-hidden="true" />
      <span className="muted small">{label || 'Cargando…'}</span>
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="form-error">
      <strong>No se pudo cargar la informacion.</strong> {error.message}
      {onRetry && (
        <>
          {' '}
          <button type="button" className="btn btn--sm btn--ghost" onClick={onRetry}>
            Reintentar
          </button>
        </>
      )}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

/** Barra proporcional dentro de una celda de tabla (mide, no decora). */
export function BarCell({ value, max, format = n, color = 'var(--series-1)' }) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div className="bar-cell">
      <span className="tnum">{format(value)}</span>
      <span className="bar-cell__track">
        <span className="bar-cell__fill" style={{ width: `${ratio * 100}%`, background: color }} />
      </span>
    </div>
  );
}

/** Celda de ACH% con semaforo: color + texto, nunca color solo. */
export function AchCell({ value }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  const tone = achTone(value);
  return (
    <span className="tnum" style={{ color: `var(--status-${tone}-ink)`, fontWeight: 560 }}>
      {pct(value)}
    </span>
  );
}

/**
 * Tabla ordenable. Es tambien la "vista de tabla" que acompaña a los graficos,
 * de modo que ningun valor dependa unicamente del color o del tooltip.
 */
export function DataTable({ columns, rows, initialSort, rowKey = (r, i) => r.key ?? i, onRowClick, emptyText }) {
  const [sort, setSort] = useState(initialSort || null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.sortValue || ((row) => row[col.key]);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv), 'es') * dir;
      }
      return (av - bv) * dir;
    });
  }, [rows, sort, columns]);

  function toggle(col) {
    if (col.sortable === false) return;
    setSort((prev) => {
      if (!prev || prev.key !== col.key) return { key: col.key, dir: col.defaultDir || 'desc' };
      return { key: col.key, dir: prev.dir === 'desc' ? 'asc' : 'desc' };
    });
  }

  if (!rows.length) return <Empty>{emptyText || 'No hay registros con los filtros actuales.'}</Empty>;

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={`${col.numeric ? 'num' : ''}${col.sortable === false ? ' is-static' : ''}`}
                onClick={() => toggle(col)}
                scope="col"
                title={col.title}
              >
                {col.label}
                {sort?.key === col.key && <span className="sort-caret">{sort.dir === 'desc' ? '▼' : '▲'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={onRowClick ? { cursor: 'pointer' } : undefined}
            >
              {columns.map((col) => (
                <td key={col.key} className={`${col.numeric ? 'num' : ''} ${col.cellClass || ''}`}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Alterna entre grafico y tabla dentro de una misma tarjeta. */
export function ViewToggle({ value, onChange }) {
  return (
    <div className="row" role="group" aria-label="Cambiar vista">
      <button
        type="button"
        className={`btn btn--sm${value === 'chart' ? ' btn--primary' : ''}`}
        onClick={() => onChange('chart')}
        aria-pressed={value === 'chart'}
      >
        Grafico
      </button>
      <button
        type="button"
        className={`btn btn--sm${value === 'table' ? ' btn--primary' : ''}`}
        onClick={() => onChange('table')}
        aria-pressed={value === 'table'}
      >
        Tabla
      </button>
    </div>
  );
}
