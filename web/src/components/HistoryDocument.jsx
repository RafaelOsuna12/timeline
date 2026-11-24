/**
 * Historial por persona: una hoja horizontal por promotor o supervisor.
 *
 * La hoja se lee de arriba abajo en cuatro bloques: quien es, como le fue en
 * conjunto, el mes a mes en numeros y el mes a mes en grafico. Va en
 * horizontal porque la tabla tiene una columna por concepto y los meses
 * crecen hacia los lados; en vertical habria que partirla.
 *
 * Las piezas y los porcentajes van en dos graficos separados a proposito: son
 * dos escalas distintas y juntarlas en un mismo eje doble es la forma mas
 * comun de hacer ilegible una comparacion.
 */
import { Brand } from './Brand.jsx';
import { MonthlyAchBars, MonthlyTargetBars } from './charts/index.jsx';
import { STATUS_LABELS, d1, d2, dateLabel, n, pct, signed } from '../utils/format.js';

/** Antiguedad legible; la misma forma que usa Datos del personal. */
function tenureLabel(months) {
  if (months === null || months === undefined) return null;
  if (months < 1) return 'menos de 1 mes';
  if (months < 12) return `${months} ${months === 1 ? 'mes' : 'meses'}`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return `${y} ${y === 1 ? 'año' : 'años'}${m ? ` ${m} ${m === 1 ? 'mes' : 'meses'}` : ''}`;
}

export default function HistoryDocument({ data }) {
  return (
    <div className="report report--landscape">
      {data.people.map((p) => (
        <PersonSheet key={p.id} person={p} generatedAt={data.generatedAt} periods={data.periods} />
      ))}
    </div>
  );
}

function PersonSheet({ person, generatedAt, periods }) {
  const t = person.totals;
  const esSupervisor = person.kind === 'supervisor';
  const antiguedad = tenureLabel(person.tenureMonths);
  const conDatos = person.months.filter((m) => m.present);
  const parciales = conDatos.filter((m) => !m.complete);
  // La tabla crece un renglon por mes; los graficos ceden alto para que todo
  // siga cabiendo en una sola hoja.
  const alturaGrafico = person.months.length <= 6 ? 168 : person.months.length <= 9 ? 146 : 124;

  return (
    <section className="report__section hist">
      <header className="hist__head">
        <div>
          <h2 className="hist__name">{person.name}</h2>
          <p className="hist__meta">
            {esSupervisor ? 'Supervisor' : 'Promotor'}
            {person.region ? ` · ${person.region}` : ''}
            {person.cm ? ` · CM ${person.cm}` : ''}
            {!esSupervisor && person.supervisor ? ` · supervisor ${person.supervisor}` : ''}
            {!esSupervisor && person.store ? ` · ${person.store}` : ''}
          </p>
          <p className="hist__meta">
            {person.hireDate ? (
              <>
                Ingreso el {person.hireDate}
                {antiguedad ? ` · ${antiguedad} en la empresa` : ''}
              </>
            ) : esSupervisor ? (
              'El archivo de plantilla no registra fecha de ingreso de los supervisores'
            ) : (
              'Sin fecha de ingreso registrada'
            )}
          </p>
        </div>
        <div className="hist__brand">
          <Brand height={16} />
          <span className="hist__period">
            {periods[0]?.label} a {periods[periods.length - 1]?.label} · {n(t.monthsWithData)} de {n(t.monthsSelected)} meses con registro
          </span>
        </div>
      </header>

      <div className="hist__kpis">
        <Figure label="Meta del periodo" value={n(t.target)} unit="pzs" note={`${d1(t.monthlyTarget)} pzs por mes en promedio`} />
        <Figure label="Piezas vendidas" value={n(t.so)} unit="pzs" note={`${n(t.soAll)} incluyendo todas las series`} />
        <Figure
          label="Cumplimiento del periodo"
          value={pct(t.ach)}
          note={t.gap > 0 ? `Faltaron ${n(t.gap)} piezas` : 'Meta alcanzada'}
          status={t.status}
        />
        <Figure label="Promedio mensual" value={d1(t.monthlyAverage)} unit="pzs" note={`Sobre ${n(t.monthsWithData)} meses con registro`} />
        <Figure
          label="Tendencia"
          value={t.trendPoints === null ? '—' : `${signed(Math.round(t.trendPoints * 1000) / 10)} pts`}
          note={t.firstMonth && t.lastMonth ? `De ${t.firstMonth} a ${t.lastMonth}` : 'Un solo mes con meta'}
        />
      </div>

      <table className="report__table report__table--data hist__table">
        <thead>
          <tr>
            <th>Mes</th>
            <th className="num">Meta</th>
            <th className="num">Vendido</th>
            <th className="num">Cumplimiento</th>
            <th className="num">Faltaron</th>
            {esSupervisor && <th className="num">Promotores</th>}
            <th className="num">Dias trabajados</th>
            <th className="num">Pzs por dia</th>
            <th className="num">Vs. mes anterior</th>
            <th>Estatus</th>
          </tr>
        </thead>
        <tbody>
          {person.months.map((m) => (
            <tr key={m.periodKey} className={m.present ? undefined : 'is-missing'}>
              <td className="name">
                {m.label}
                {m.present && !m.complete && <span className="hist__flag"> al dia {m.cutoffDay}</span>}
              </td>
              {m.present ? (
                <>
                  <td className="num">{n(m.target)}</td>
                  <td className="num">{n(m.so)}</td>
                  <td className="num">{pct(m.ach)}</td>
                  <td className="num">{m.gap > 0 ? n(m.gap) : '—'}</td>
                  {esSupervisor && <td className="num">{n(m.headcount)}</td>}
                  <td className="num">{n(m.attendanceDays)}</td>
                  <td className="num">{d2(m.productivity)}</td>
                  <td className="num">
                    {m.deltaPoints === null || m.deltaPoints === undefined
                      ? '—'
                      : `${signed(Math.round(m.deltaPoints * 1000) / 10)} pts`}
                  </td>
                  <td>
                    <span className={`report__status report__status--${m.status}`}>{STATUS_LABELS[m.status] || m.status}</span>
                  </td>
                </>
              ) : (
                <td className="muted" colSpan={esSupervisor ? 9 : 8}>
                  Sin registro en este mes
                </td>
              )}
            </tr>
          ))}
          <tr className="hist__total">
            <th>Total del periodo</th>
            <th className="num">{n(t.target)}</th>
            <th className="num">{n(t.so)}</th>
            <th className="num">{pct(t.ach)}</th>
            <th className="num">{t.gap > 0 ? n(t.gap) : '—'}</th>
            {esSupervisor && <th className="num">—</th>}
            <th className="num">{n(t.attendanceDays)}</th>
            <th className="num">{d2(t.productivity)}</th>
            <th className="num">—</th>
            <th>
              <span className={`report__status report__status--${t.status}`}>{STATUS_LABELS[t.status] || t.status}</span>
            </th>
          </tr>
        </tbody>
      </table>

      <div className="hist__charts">
        <div>
          <h3 className="report__h3">Venta contra meta por mes</h3>
          <MonthlyTargetBars months={conDatos} height={alturaGrafico} />
        </div>
        <div>
          <h3 className="report__h3">Cumplimiento por mes</h3>
          <MonthlyAchBars months={conDatos} height={alturaGrafico} />
        </div>
      </div>

      <p className="report__foot hist__foot">
        {t.best && t.worst && t.best.label !== t.worst.label ? (
          <>
            Mejor mes <strong>{t.best.label}</strong> con {pct(t.best.ach)} ({n(t.best.so)} pzs) · mas bajo{' '}
            <strong>{t.worst.label}</strong> con {pct(t.worst.ach)} ({n(t.worst.so)} pzs).{' '}
          </>
        ) : null}
        {parciales.length > 0 && (
          <>
            {parciales.length === 1 ? 'Mes incompleto' : 'Meses incompletos'}: {parciales.map((m) => m.label).join(', ')} — su
            archivo no llega al cierre, asi que su venta no es comparable con la de un mes completo.{' '}
          </>
        )}
        Generado el {dateLabel(generatedAt)}.
      </p>
    </section>
  );
}

function Figure({ label, value, unit, note, status }) {
  return (
    <div className="report__kpi">
      <div className="report__kpi-label">{label}</div>
      <div className="report__kpi-value">
        {value}
        {unit && <span className="report__kpi-unit"> {unit}</span>}
      </div>
      {note && <div className="report__kpi-note">{note}</div>}
      {status && (
        <div className="report__kpi-note">
          <span className={`report__status report__status--${status}`}>{STATUS_LABELS[status] || status}</span>
        </div>
      )}
    </div>
  );
}
