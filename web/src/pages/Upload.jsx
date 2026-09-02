/**
 * Carga del archivo de Excel.
 *
 * El servidor procesa en segundo plano, asi que aqui se sube el archivo y
 * despues se consulta el avance del trabajo hasta que termina.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, uploadFile } from '../api.js';
import { useAuth, useData } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import { Card, DataTable, Empty, Spinner } from '../components/ui.jsx';
import { dateLabel, n, periodLabel } from '../utils/format.js';

export default function Upload() {
  const { user } = useAuth();
  const { refresh, snapshots } = useData();
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const pollRef = useRef(null);

  const [dragging, setDragging] = useState(false);
  const [uploadPct, setUploadPct] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const start = useCallback(
    async (file) => {
      setError(null);
      setJob(null);
      setUploadPct(0);
      try {
        const res = await uploadFile(file, setUploadPct);
        setUploadPct(100);
        setJob({ state: 'running', step: 'Procesando el libro…', progress: 5 });
        clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          try {
            const status = await api.uploadJob(res.jobId);
            setJob(status);
            if (status.state === 'done' || status.state === 'error') {
              clearInterval(pollRef.current);
              if (status.state === 'done') refresh();
            }
          } catch (e) {
            clearInterval(pollRef.current);
            setError(e);
          }
        }, 1200);
      } catch (e) {
        setUploadPct(null);
        setError(e);
      }
    },
    [refresh]
  );

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) start(file);
  }

  const busy = uploadPct !== null && (!job || job.state === 'running' || job.state === 'queued');

  return (
    <AppShell title="Cargar archivo" subtitle="Actualiza el tablero con el reporte diario de sell-out">
      <div className="grid grid--wide-left">
        <Card
          title="Nuevo archivo"
          hint="Arrastra el archivo R123_DailySO_Models_*.xlsx o seleccionalo. El sistema detecta solo el mes y el ultimo dia con informacion."
        >
          <div
            className={`dropzone${dragging ? ' is-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => !busy && inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !busy) inputRef.current?.click();
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xlsm"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) start(file);
                e.target.value = '';
              }}
            />
            <div style={{ fontWeight: 570, marginBottom: 4 }}>
              {busy ? 'Procesando…' : 'Arrastra el archivo aqui o haz clic para elegirlo'}
            </div>
            <div className="muted small">Formatos aceptados: .xlsx y .xlsm · hasta 80 MB</div>
          </div>

          {uploadPct !== null && (
            <div className="stack" style={{ gap: 8, marginTop: 14 }}>
              <div className="spread small">
                <span className="secondary">
                  {uploadPct < 100 ? 'Subiendo archivo' : job?.step || 'Procesando'}
                </span>
                <span className="tnum muted">{uploadPct < 100 ? `${uploadPct}%` : `${job?.progress ?? 0}%`}</span>
              </div>
              <div className="progress">
                <span style={{ width: `${uploadPct < 100 ? uploadPct : job?.progress ?? 0}%` }} />
              </div>
            </div>
          )}

          {error && <div className="form-error" style={{ marginTop: 12 }}>{error.message}</div>}

          {job?.state === 'error' && (
            <div className="form-error" style={{ marginTop: 12 }}>
              <strong>No se pudo procesar el archivo.</strong> {job.error}
            </div>
          )}

          {job?.state === 'done' && job.duplicate && (
            <div className="form-ok" style={{ marginTop: 12 }}>{job.message}</div>
          )}

          {job?.state === 'done' && !job.duplicate && job.summary && (
            <div className="stack" style={{ gap: 10, marginTop: 12 }}>
              <div className="form-ok">
                <strong>Archivo procesado.</strong> {periodLabel(job.summary.periodKey)}, informacion al dia{' '}
                {job.summary.cutoffDay} de {job.summary.daysInMonth}. Se cargaron {n(job.summary.promoters)} promotores y{' '}
                {n(job.summary.leaders)} lideres.
              </div>
              {job.summary.warnings?.length > 0 && (
                <div className="alert alert--warning">
                  <div>
                    <div className="alert__title">Avisos del procesamiento</div>
                    <ul className="alert__detail" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {job.summary.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              <div className="row">
                <button type="button" className="btn btn--primary" onClick={() => navigate('/')}>
                  Ver el tablero actualizado
                </button>
              </div>
            </div>
          )}
        </Card>

        <Card title="Como funciona" hint="Lo que el sistema lee del archivo.">
          <ol className="small secondary" style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 7 }}>
            <li>
              Detecta el periodo y los dias del mes desde las fechas de la hoja <code>1.Daily_Retail_FF_SO_Target</code>,
              por lo que no importa si el mes tiene 28, 30 o 31 dias.
            </li>
            <li>
              Toma el sell-out de modelos foco, el de todas las series, IOT, asistencia y dias en cero de cada promotor,
              junto con su tienda, canal, supervisor y city manager.
            </li>
            <li>Lee la hoja de supervisores y CM para reconstruir la estructura de equipos por region.</li>
            <li>Incorpora la mezcla mensual de modelos, los productos clave por canal y las variantes por version y color.</li>
            <li>
              Calcula el ultimo dia con informacion (el corte) y, a partir de ahi, el avance y la proyeccion de cierre.
            </li>
          </ol>
          <p className="card__hint" style={{ marginTop: 12 }}>
            Cada carga se guarda como una version independiente. Nada se sobrescribe: puedes volver a cualquier
            actualizacion anterior y comparar el avance entre dos de ellas.
          </p>
        </Card>
      </div>

      <History snapshots={snapshots} isAdmin={user?.role === 'admin'} onChange={refresh} />
    </AppShell>
  );
}

function History({ snapshots, isAdmin, onChange }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  async function remove(id) {
    if (!window.confirm('Se eliminara esta carga y todo su detalle. Esta accion no se puede deshacer. Continuar?')) return;
    setBusyId(id);
    setError(null);
    try {
      await api.deleteSnapshot(id);
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card title="Historial de cargas" hint="Todas las actualizaciones procesadas, de la mas reciente a la mas antigua.">
      {error && <div className="form-error" style={{ marginBottom: 10 }}>{error.message}</div>}
      {snapshots.length === 0 ? (
        <Empty>Todavia no se ha cargado ningun archivo.</Empty>
      ) : (
        <DataTable
          columns={[
            { key: 'periodKey', label: 'Periodo', render: (s) => periodLabel(s.periodKey) },
            { key: 'cutoffDay', label: 'Dia de corte', numeric: true, render: (s) => `${s.cutoffDay} / ${s.daysInMonth}` },
            { key: 'promoterCount', label: 'Promotores', numeric: true, render: (s) => n(s.promoterCount) },
            { key: 'createdAt', label: 'Cargado', render: (s) => dateLabel(s.createdAt) },
            { key: 'uploadedBy', label: 'Por', cellClass: 'dim' },
            { key: 'sourceName', label: 'Archivo', cellClass: 'dim' },
            {
              key: 'warnings',
              label: 'Avisos',
              numeric: true,
              sortValue: (s) => s.warnings.length,
              render: (s) => (s.warnings.length ? `${s.warnings.length}` : '—'),
            },
            {
              key: 'actions',
              label: '',
              sortable: false,
              render: (s) =>
                isAdmin ? (
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={busyId === s.id || snapshots.length <= 1}
                    onClick={() => remove(s.id)}
                  >
                    Eliminar
                  </button>
                ) : null,
            },
          ]}
          rows={snapshots}
          rowKey={(s) => s.id}
          initialSort={{ key: 'createdAt', dir: 'desc' }}
        />
      )}
    </Card>
  );
}
