/**
 * Reportes para imprimir.
 *
 * Dos mitades: arriba se arma el reporte —que regiones, que CMs, que
 * supervisores, que promotores y con cuanto detalle— y abajo se genera el
 * documento, que es lo unico que sale en papel. Todo lo demas lleva `no-print`.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, downloadCsv } from '../api.js';
import { useData, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import { Card, Empty, ErrorBox, Spinner } from '../components/ui.jsx';
import { n, periodLabel } from '../utils/format.js';
import ReportDocument from '../components/ReportDocument.jsx';
import HistoryDocument from '../components/HistoryDocument.jsx';

const SECTIONS = [
  { key: 'resumen', label: 'Resumen del alcance', hint: 'Meta, venta, cumplimiento y proyeccion del conjunto elegido.' },
  { key: 'regiones', label: 'Analisis por region', hint: 'Una pagina por region con su avance y sus CM.' },
  { key: 'cms', label: 'Analisis por city manager', hint: 'Cada CM con el desglose de sus supervisores.' },
  { key: 'supervisores', label: 'Analisis por supervisor', hint: 'Cada supervisor con la tabla de su equipo.' },
  { key: 'promotores', label: 'Ficha por promotor', hint: 'Una ficha individual por cada promotor del alcance.' },
  { key: 'bajo_rendimiento', label: 'Reporte de bajo rendimiento', hint: 'Quien no llega al per capita ni al minimo del 60%.' },
];

const DEFAULT_SECTIONS = ['resumen', 'regiones', 'cms', 'supervisores', 'bajo_rendimiento'];

const MODOS = [
  { key: 'mes', label: 'Reporte del mes', hint: 'El corte de un mes, por region, CM, supervisor o promotor.' },
  { key: 'historial', label: 'Historial por persona', hint: 'Varios meses de un promotor o supervisor, una hoja horizontal por persona.' },
];

export default function Reports() {
  const [modo, setModo] = useState('mes');
  if (modo === 'historial') return <HistoryReport modo={modo} onModo={setModo} />;
  return <MonthlyReport modo={modo} onModo={setModo} />;
}

/** Interruptor entre los dos reportes; va arriba de todo en ambos. */
function ModeSwitch({ modo, onModo }) {
  return (
    <div className="no-print" style={{ marginBottom: 16 }}>
      <div className="chip-row" style={{ paddingBottom: 6 }}>
        {MODOS.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`btn btn--sm${modo === m.key ? ' btn--primary' : ''}`}
            onClick={() => onModo(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="muted small" style={{ margin: 0 }}>{MODOS.find((m) => m.key === modo)?.hint}</p>
    </div>
  );
}

function MonthlyReport({ modo, onModo }) {
  const { filters, setFilter, snapshots, hasData, activeSnapshot } = useData();

  const [regions, setRegions] = useState([]);
  const [cms, setCms] = useState([]);
  const [supervisors, setSupervisors] = useState([]);
  const [promoters, setPromoters] = useState([]);
  const [sections, setSections] = useState(DEFAULT_SECTIONS);
  const [withDaily, setWithDaily] = useState(false);
  const [minDaily, setMinDaily] = useState(2);
  const [request, setRequest] = useState(null);

  // Catalogo de promotores del alcance, para poder elegirlos uno por uno.
  const { data: promoterList } = useQuery(
    (signal) => api.promoters({ ...filters, region: undefined, cm: undefined, supervisor: undefined }, signal),
    [filters.snapshot, filters.asOfDay],
    { skip: !hasData }
  );

  // Las opciones salen de los promotores que el reporte va a incluir, no del
  // catalogo completo: asi no se ofrece elegir una region OFFLINE que despues
  // saldria vacia.
  const options = useMemo(() => {
    const rows = promoterList?.promoters || [];
    const inRegion = (r) => !regions.length || regions.includes(r.region);
    const inCm = (r) => !cms.length || cms.includes(r.cm);
    const uniq = (fn, pred = () => true) =>
      [...new Set(rows.filter(pred).map(fn))].filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), 'es'));
    return {
      regions: uniq((r) => r.region),
      cms: uniq((r) => r.cm, inRegion),
      supervisors: uniq((r) => r.supervisor, (r) => inRegion(r) && inCm(r)),
    };
  }, [promoterList, regions, cms]);

  const promoterOptions = useMemo(() => {
    if (!promoterList) return [];
    return promoterList.promoters
      .filter(
        (p) =>
          (!regions.length || regions.includes(p.region)) &&
          (!cms.length || cms.includes(p.cm)) &&
          (!supervisors.length || supervisors.includes(p.supervisor))
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [promoterList, regions, cms, supervisors]);

  // Al cambiar un nivel de arriba se descartan las elecciones que ya no existen.
  useEffect(() => {
    setCms((prev) => prev.filter((v) => options.cms.includes(v)));
  }, [options.cms.join('|')]);
  useEffect(() => {
    setSupervisors((prev) => prev.filter((v) => options.supervisors.includes(v)));
  }, [options.supervisors.join('|')]);
  useEffect(() => {
    const keys = new Set(promoterOptions.map((p) => p.key));
    setPromoters((prev) => prev.filter((k) => keys.has(k)));
  }, [promoterOptions]);

  const query = useMemo(
    () => ({
      snapshot: filters.snapshot,
      asOfDay: filters.asOfDay,
      channel: filters.channel,
      regions: regions.join(',') || undefined,
      cms: cms.join(',') || undefined,
      supervisors: supervisors.join(',') || undefined,
      promoters: promoters.join(',') || undefined,
      sections: sections.join(','),
      withDaily: withDaily || undefined,
      minDaily,
    }),
    [filters, regions, cms, supervisors, promoters, sections, withDaily, minDaily]
  );

  const { data, error, loading } = useQuery((signal) => api.report(request, signal), [JSON.stringify(request)], {
    skip: !request,
  });

  const sheetCount = sections.includes('promotores')
    ? promoters.length || promoterOptions.length || promoterList?.promoters.length || 0
    : 0;

  return (
    <AppShell
      title="Reportes para imprimir"
      subtitle="Arma el documento, revisalo en pantalla y mandalo a papel o a PDF"
      actions={
        data && (
          <div className="row no-print">
            <button type="button" className="btn btn--sm btn--primary" onClick={() => window.print()}>
              Imprimir o guardar PDF
            </button>
            {data.lowPerformance && (
              <button type="button" className="btn btn--sm" onClick={() => downloadCsv('bajo_rendimiento', query)}>
                CSV de bajo rendimiento
              </button>
            )}
          </div>
        )
      }
    >
      <ModeSwitch modo={modo} onModo={onModo} />

      {!hasData && <Empty>Aun no hay informacion cargada.</Empty>}

      {hasData && (
        <div className="stack no-print">
          <Card
            title="1. Periodo"
            hint="El reporte se arma sobre la carga elegida, asi que se puede imprimir un mes ya cerrado."
          >
            <PeriodPicker
              snapshots={snapshots}
              active={activeSnapshot}
              onChange={(id) => {
                setFilter('snapshot', id);
                setRequest(null);
              }}
            />
          </Card>

          <Card
            title="2. Alcance"
            hint="Deja una lista vacia para incluirlo todo. Las listas se encadenan: al elegir una region solo aparecen sus CM."
          >
            <div className="picker-grid">
              <Picker label="Regiones" options={options.regions} value={regions} onChange={setRegions} allLabel="Todas las regiones" />
              <Picker label="City managers" options={options.cms} value={cms} onChange={setCms} allLabel="Todos los CM" />
              <Picker
                label="Supervisores"
                options={options.supervisors}
                value={supervisors}
                onChange={setSupervisors}
                allLabel="Todos los supervisores"
              />
              <Picker
                label="Promotores"
                options={promoterOptions.map((p) => p.key)}
                labels={Object.fromEntries(promoterOptions.map((p) => [p.key, `${p.name} · ${p.store}`]))}
                value={promoters}
                onChange={setPromoters}
                allLabel="Todos los promotores"
                searchable
              />
            </div>
          </Card>

          <Card title="3. Contenido" hint="Cada seccion empieza en una pagina nueva.">
            <div className="stack" style={{ gap: 10 }}>
              {SECTIONS.map((s) => (
                <label key={s.key} className="check">
                  <input
                    type="checkbox"
                    checked={sections.includes(s.key)}
                    onChange={(e) =>
                      setSections((prev) =>
                        e.target.checked ? [...prev, s.key] : prev.filter((k) => k !== s.key)
                      )
                    }
                  />
                  <span>
                    <strong>{s.label}</strong>
                    <span className="muted small"> — {s.hint}</span>
                  </span>
                </label>
              ))}

              {sections.includes('promotores') && (
                <>
                  <label className="check" style={{ marginLeft: 24 }}>
                    <input type="checkbox" checked={withDaily} onChange={(e) => setWithDaily(e.target.checked)} />
                    <span>
                      Incluir el detalle dia por dia en cada ficha
                      <span className="muted small"> — agrega una tabla de {activeSnapshot?.daysInMonth || 30} filas por promotor.</span>
                    </span>
                  </label>
                  {sheetCount > 25 && (
                    <div className="alert alert--warning" style={{ margin: 0 }}>
                      El alcance actual son {n(sheetCount)} fichas de promotor{withDaily ? ', cada una con su tabla diaria' : ''}.
                      Son muchas paginas: elige supervisores o promotores concretos si buscas un documento manejable.
                    </div>
                  )}
                </>
              )}

              {sections.includes('bajo_rendimiento') && (
                <label className="field" style={{ marginLeft: 24, maxWidth: 260 }}>
                  <span className="field__label">Per capita minimo (pzs por dia trabajado)</span>
                  <input
                    className="control"
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={minDaily}
                    onChange={(e) => setMinDaily(Number(e.target.value) || 0.1)}
                  />
                </label>
              )}
            </div>
          </Card>

          <div className="row">
            <button type="button" className="btn btn--primary" onClick={() => setRequest(query)} disabled={!sections.length}>
              {data ? 'Actualizar reporte' : 'Generar reporte'}
            </button>
            {data && <span className="muted small">Revisa el documento abajo y usa "Imprimir o guardar PDF".</span>}
          </div>
        </div>
      )}

      <ErrorBox error={error} />
      {loading && <Spinner label="Armando el documento…" />}
      {data && <ReportDocument data={data} />}
    </AppShell>
  );
}

/** Mes y carga concreta sobre los que se arma el documento. */
function PeriodPicker({ snapshots, active, onChange }) {
  const periods = useMemo(() => {
    const seen = new Map();
    for (const s of snapshots) if (!seen.has(s.periodKey)) seen.set(s.periodKey, s);
    return [...seen.values()];
  }, [snapshots]);
  const updates = useMemo(
    () => (active ? snapshots.filter((s) => s.periodKey === active.periodKey) : []),
    [snapshots, active]
  );

  return (
    <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
      <label className="field" style={{ minWidth: 170 }}>
        <span className="field__label">Mes</span>
        <select
          className="control"
          value={active ? active.periodKey : ''}
          onChange={(e) => {
            const match = snapshots.find((s) => s.periodKey === e.target.value);
            if (match) onChange(String(match.id));
          }}
        >
          {periods.map((p) => (
            <option key={p.periodKey} value={p.periodKey}>
              {periodLabel(p.periodKey)}
            </option>
          ))}
        </select>
      </label>

      {updates.length > 1 && (
        <label className="field" style={{ minWidth: 200 }}>
          <span className="field__label">Actualizacion</span>
          <select className="control" value={active ? String(active.id) : ''} onChange={(e) => onChange(e.target.value)}>
            {updates.map((s) => (
              <option key={s.id} value={s.id}>
                Dia {s.cutoffDay} · cargado {new Date(s.createdAt).toLocaleDateString('es-MX')}
              </option>
            ))}
          </select>
        </label>
      )}

      {active && (
        <span className="muted small" style={{ alignSelf: 'flex-end', paddingBottom: 8 }}>
          Informacion al dia {active.cutoffDay} de {active.daysInMonth}
          {active.cutoffDay >= active.daysInMonth ? ' · mes cerrado' : ` · faltan ${active.daysInMonth - active.cutoffDay} dias`}
        </span>
      )}
    </div>
  );
}

/** Lista de casillas con "todos" implicito cuando no hay nada marcado. */
function Picker({ label, options, value, onChange, allLabel, labels, searchable = false }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    if (!searchable || !q.trim()) return options;
    const needle = q.trim().toUpperCase();
    return options.filter((o) => String(labels?.[o] ?? o).toUpperCase().includes(needle));
  }, [options, q, labels, searchable]);

  const toggle = (o) => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o]);

  return (
    <div className="picker">
      <div className="spread picker__head">
        <span className="field__label">{label}</span>
        <span className="muted small">
          {value.length ? `${value.length} de ${options.length}` : allLabel}
          {value.length > 0 && (
            <button type="button" className="btn btn--sm btn--ghost" style={{ padding: '0 0 0 8px' }} onClick={() => onChange([])}>
              limpiar
            </button>
          )}
        </span>
      </div>
      {searchable && (
        <input
          className="control"
          type="search"
          placeholder="Buscar"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: '100%', marginBottom: 6 }}
        />
      )}
      <div className="picker__list">
        {shown.map((o) => (
          <label key={o} className="check check--tight">
            <input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} />
            <span>{labels?.[o] ?? o}</span>
          </label>
        ))}
        {!shown.length && <div className="muted small" style={{ padding: '6px 2px' }}>Sin opciones.</div>}
      </div>
    </div>
  );
}

/* --------------------------- historial por persona --------------------------- */

/**
 * Armado del historial: que meses y que personas.
 *
 * Los meses incompletos vienen desmarcados porque su venta no es comparable
 * con la de un mes cerrado; se pueden incluir, y entonces la hoja los señala.
 */
function HistoryReport({ modo, onModo }) {
  const [periods, setPeriods] = useState(null); // null = aun sin decidir, se llena al cargar
  const [promoters, setPromoters] = useState([]);
  const [supervisors, setSupervisors] = useState([]);
  const [request, setRequest] = useState(null);

  const { data: options, error: optionsError, loading: loadingOptions } = useQuery(
    (signal) => api.historyOptions({}, signal),
    []
  );

  // Al llegar el catalogo se preseleccionan los meses completos.
  useEffect(() => {
    if (!options || periods !== null) return;
    setPeriods(options.periods.filter((p) => p.complete).map((p) => p.periodKey));
  }, [options, periods]);

  const elegidos = periods || [];
  const query = useMemo(
    () => ({
      periods: elegidos.join(',') || undefined,
      promoters: promoters.join(',') || undefined,
      supervisors: supervisors.join(',') || undefined,
    }),
    [elegidos, promoters, supervisors]
  );

  const { data, error, loading } = useQuery((signal) => api.history(request, signal), [JSON.stringify(request)], {
    skip: !request,
  });

  const total = promoters.length + supervisors.length;
  const puede = elegidos.length > 0 && total > 0;

  return (
    <AppShell
      title="Reportes para imprimir"
      subtitle="Historial de varios meses por promotor o supervisor"
      actions={
        data && (
          <div className="row no-print">
            <button type="button" className="btn btn--sm btn--primary" onClick={() => window.print()}>
              Imprimir o guardar PDF
            </button>
          </div>
        )
      }
    >
      <ModeSwitch modo={modo} onModo={onModo} />
      <ErrorBox error={optionsError} />
      {loadingOptions && !options && <Spinner />}

      {options && (
        <div className="stack no-print">
          <Card
            title="1. Meses"
            hint="Los meses incompletos vienen desmarcados: su archivo no llega al cierre y compararlos con un mes cerrado se leeria como una caida de ventas."
          >
            <div className="chip-row" style={{ paddingBottom: 0 }}>
              {options.periods.map((p) => {
                const activo = elegidos.includes(p.periodKey);
                return (
                  <button
                    key={p.periodKey}
                    type="button"
                    className={`btn btn--sm${activo ? ' btn--primary' : ''}`}
                    onClick={() =>
                      setPeriods((prev) =>
                        (prev || []).includes(p.periodKey)
                          ? prev.filter((k) => k !== p.periodKey)
                          : [...(prev || []), p.periodKey].sort()
                      )
                    }
                  >
                    {p.label}
                    {!p.complete && <span className="tag tag--soft">al dia {p.cutoffDay}</span>}
                  </button>
                );
              })}
            </div>
          </Card>

          <Card title="2. Personas" hint="Una hoja horizontal por cada persona elegida. Los supervisores salen primero.">
            <div className="picker-grid">
              <Picker
                label="Supervisores"
                options={options.supervisors.map((s) => s.key)}
                labels={Object.fromEntries(
                  options.supervisors.map((s) => [s.key, `${s.name} · ${s.region || 'sin region'} · ${s.months} meses`])
                )}
                value={supervisors}
                onChange={setSupervisors}
                allLabel="Ninguno"
                searchable
              />
              <Picker
                label="Promotores"
                options={options.promoters.map((p) => p.key)}
                labels={Object.fromEntries(
                  options.promoters.map((p) => [p.key, `${p.name} · ${p.store || ''} · ${p.months} meses`])
                )}
                value={promoters}
                onChange={setPromoters}
                allLabel="Ninguno"
                searchable
              />
            </div>
          </Card>

          <div className="row">
            <button type="button" className="btn btn--primary" onClick={() => setRequest(query)} disabled={!puede}>
              {data ? 'Actualizar historial' : 'Generar historial'}
            </button>
            <span className="muted small">
              {puede
                ? `${n(total)} ${total === 1 ? 'hoja' : 'hojas'} sobre ${n(elegidos.length)} ${
                    elegidos.length === 1 ? 'mes' : 'meses'
                  }.`
                : 'Elige al menos un mes y una persona.'}
            </span>
          </div>
        </div>
      )}

      <ErrorBox error={error} />
      {loading && <Spinner label="Armando el historial…" />}
      {data && data.people.length === 0 && (
        <Empty>Las personas elegidas no tienen registro en los meses seleccionados.</Empty>
      )}
      {data && data.people.length > 0 && <HistoryDocument data={data} />}
    </AppShell>
  );
}
