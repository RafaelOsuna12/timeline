/**
 * Barra de filtros global.
 *
 * Es una sola fila por encima de todo lo que afecta: ninguna tarjeta tiene
 * filtros propios, de modo que todas las vistas leen siempre el mismo corte.
 */
import { useMemo } from 'react';
import { useData } from '../app/context.jsx';
import { periodLabel } from '../utils/format.js';

function Select({ label, value, onChange, options, allLabel }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <select className="control" value={value || ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FilterBar({ showDaySlider = true }) {
  const { filters, setFilter, clearFilters, catalog, snapshots, activeSnapshot } = useData();

  // Las opciones se encadenan: elegir region reduce CMs, supervisores y tiendas.
  const options = useMemo(() => {
    const rel = catalog?.relations || [];
    const match = (r) =>
      (!filters.region || r.region === filters.region) &&
      (!filters.cm || r.cm === filters.cm) &&
      (!filters.supervisor || r.supervisor === filters.supervisor) &&
      (!filters.channel || r.channel === filters.channel);
    const uniq = (fn, extraFilter = () => true) =>
      [...new Set(rel.filter((r) => extraFilter(r)).map(fn))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'es'));
    return {
      regions: catalog?.regions || [],
      channels: catalog?.channels || [],
      cms: uniq(
        (r) => r.cm,
        (r) => !filters.region || r.region === filters.region
      ),
      supervisors: uniq(
        (r) => r.supervisor,
        (r) => (!filters.region || r.region === filters.region) && (!filters.cm || r.cm === filters.cm)
      ),
      stores: uniq((r) => r.store, match),
    };
  }, [catalog, filters]);

  const activeChips = [
    filters.region && { key: 'region', label: `Region: ${filters.region}` },
    filters.cm && { key: 'cm', label: `CM: ${filters.cm}` },
    filters.supervisor && { key: 'supervisor', label: `Supervisor: ${filters.supervisor}` },
    filters.channel && { key: 'channel', label: `Canal: ${filters.channel}` },
    filters.store && { key: 'store', label: `Tienda: ${filters.store}` },
    filters.search && { key: 'search', label: `Busqueda: ${filters.search}` },
    filters.asOfDay && { key: 'asOfDay', label: `Corte al dia ${filters.asOfDay}` },
  ].filter(Boolean);

  const maxDay = activeSnapshot?.cutoffDay || 31;
  const currentDay = Number(filters.asOfDay || maxDay);

  return (
    <div className="no-print">
      <div className="filterbar">
        {snapshots.length > 1 && (
          <label className="field">
            <span className="field__label">Actualizacion</span>
            <select
              className="control"
              style={{ minWidth: 210 }}
              value={filters.snapshot || (activeSnapshot ? String(activeSnapshot.id) : '')}
              onChange={(e) => setFilter('snapshot', e.target.value)}
            >
              {snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {periodLabel(s.periodKey)} · dia {s.cutoffDay} ({new Date(s.createdAt).toLocaleDateString('es-MX')})
                </option>
              ))}
            </select>
          </label>
        )}

        <Select
          label="Region"
          value={filters.region}
          onChange={(v) => setFilter('region', v)}
          options={options.regions}
          allLabel="Todas las regiones"
        />
        <Select
          label="City manager"
          value={filters.cm}
          onChange={(v) => setFilter('cm', v)}
          options={options.cms}
          allLabel="Todos los CM"
        />
        <Select
          label="Supervisor"
          value={filters.supervisor}
          onChange={(v) => setFilter('supervisor', v)}
          options={options.supervisors}
          allLabel="Todos los supervisores"
        />
        <Select
          label="Canal"
          value={filters.channel}
          onChange={(v) => setFilter('channel', v)}
          options={options.channels}
          allLabel="Todos los canales"
        />

        <label className="field" style={{ flex: '1 1 190px' }}>
          <span className="field__label">Buscar</span>
          <input
            className="control"
            style={{ width: '100%' }}
            type="search"
            placeholder="Promotor o tienda"
            defaultValue={filters.search || ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setFilter('search', e.currentTarget.value.trim());
            }}
            onBlur={(e) => setFilter('search', e.currentTarget.value.trim())}
          />
        </label>

        {showDaySlider && maxDay > 1 && (
          <label className="field" style={{ minWidth: 190 }}>
            <span className="field__label">
              Ver el mes al dia {currentDay}
              {currentDay < maxDay ? ' (retroceso)' : ''}
            </span>
            <input
              className="control"
              type="range"
              min={1}
              max={maxDay}
              step={1}
              value={currentDay}
              onChange={(e) => setFilter('asOfDay', Number(e.target.value) === maxDay ? undefined : e.target.value)}
              style={{ padding: '6px 0', minWidth: 170 }}
            />
          </label>
        )}
      </div>

      {activeChips.length > 0 && (
        <div className="chip-row" style={{ paddingBottom: 12 }}>
          {activeChips.map((chip) => (
            <span className="chip" key={chip.key}>
              {chip.label}
              <button type="button" aria-label={`Quitar ${chip.label}`} onClick={() => setFilter(chip.key, undefined)}>
                ×
              </button>
            </span>
          ))}
          <button type="button" className="btn btn--sm btn--ghost" onClick={clearFilters}>
            Limpiar todo
          </button>
        </div>
      )}
    </div>
  );
}

export default FilterBar;
