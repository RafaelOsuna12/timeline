/**
 * Panel de PushFlow — SPA sin dependencias.
 * El enrutado usa el hash: #/app/<appId>/<vista>
 */
import { lineChart, barChart, seriesColor, formatNumber, formatPercent, onResize } from './charts.js';

const root = document.getElementById('root');
const state = { user: null, apps: [], app: null, view: 'overview', data: {} };

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
  const res = await fetch(`/admin/api${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) { state.user = null; renderLogin(); throw new Error('Sesión caducada'); }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `Error ${res.status}`);
  return data;
}

function toast(message, isError = false) {
  const node = document.createElement('div');
  node.className = `toast${isError ? ' error' : ''}`;
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), isError ? 6000 : 3200);
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const firstText = (map) => {
  if (!map || typeof map !== 'object') return '';
  const keys = Object.keys(map);
  return keys.length ? map.es || map.en || map[keys[0]] : '';
};

const dateTime = (value) => value
  ? new Date(value).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit' })
  : '—';

const STATUS_TAGS = {
  draft: ['', 'Borrador'], scheduled: ['info', 'Programada'], queued: ['info', 'En cola'],
  sending: ['warn', 'Enviando'], sent: ['ok', 'Enviada'], canceled: ['', 'Cancelada'],
  failed: ['err', 'Fallida'],
};
const statusTag = (status) => {
  const [cls, label] = STATUS_TAGS[status] || ['', status];
  return `<span class="tag ${cls}">${label}</span>`;
};

/** Enlaza los formularios y botones de la vista actual. */
function bind(selector, event, handler) {
  root.querySelectorAll(selector).forEach((node) => node.addEventListener(event, handler));
}

// ---------------------------------------------------------------------------
// Acceso
// ---------------------------------------------------------------------------
function renderLogin(message = '') {
  root.innerHTML = `
    <div class="login-wrap"><div class="card login-card">
      <div class="brand"><span class="logo">🔔</span> PushFlow</div>
      <form id="login-form">
        <div class="field">
          <label for="email">Correo electrónico</label>
          <input id="email" name="email" type="email" required autocomplete="username" autofocus>
        </div>
        <div class="field">
          <label for="password">Contraseña</label>
          <input id="password" name="password" type="password" required autocomplete="current-password">
        </div>
        ${message ? `<p class="small" style="color:var(--critical)">${esc(message)}</p>` : ''}
        <button type="submit" style="width:100%">Entrar</button>
      </form>
    </div></div>`;

  root.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const result = await api('/login', { method: 'POST',
        body: { email: form.get('email'), password: form.get('password') } });
      state.user = result.user;
      await boot();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Estructura general
// ---------------------------------------------------------------------------
const NAV = [
  { section: 'Mensajes' },
  { id: 'overview', icon: '📊', label: 'Resumen' },
  { id: 'compose', icon: '✏️', label: 'Nueva notificación' },
  { id: 'notifications', icon: '📨', label: 'Historial' },
  { id: 'automations', icon: '⚡', label: 'Automatizaciones' },
  { section: 'Audiencia' },
  { id: 'audience', icon: '👥', label: 'Suscriptores' },
  { id: 'segments', icon: '🎯', label: 'Segmentos' },
  { section: 'Configuración' },
  { id: 'install', icon: '🔌', label: 'Instalación' },
  { id: 'settings', icon: '⚙️', label: 'Ajustes' },
];

function shell(content) {
  const appOptions = state.apps.map((app) =>
    `<option value="${app.id}"${app.id === state.app?.id ? ' selected' : ''}>${esc(app.name)}</option>`).join('');

  root.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><span class="logo">🔔</span> PushFlow</div>
        ${state.apps.length > 1 ? `<select id="app-switch" class="mb">${appOptions}</select>` : ''}
        ${NAV.map((item) => item.section
          ? `<div class="nav-section">${item.section}</div>`
          : `<button class="nav-item${state.view === item.id ? ' active' : ''}" data-view="${item.id}">
               <span>${item.icon}</span> ${item.label}</button>`).join('')}
        <div style="margin-top:auto;padding-top:16px">
          <button class="nav-item" id="logout"><span>🚪</span> Cerrar sesión</button>
          <div class="small muted" style="padding:8px 10px">${esc(state.user?.email || '')}</div>
        </div>
      </aside>
      <main class="main">${content}</main>
    </div>`;

  bind('[data-view]', 'click', (event) => go(event.currentTarget.dataset.view));
  root.querySelector('#logout')?.addEventListener('click', async () => {
    await api('/logout', { method: 'POST' });
    state.user = null; renderLogin();
  });
  root.querySelector('#app-switch')?.addEventListener('change', (event) => {
    state.app = state.apps.find((a) => a.id === event.target.value);
    go('overview');
  });
}

function go(view) {
  state.view = view;
  if (state.app) location.hash = `#/app/${state.app.id}/${view}`;
  render();
}

const VIEWS = {};
async function render() {
  if (!state.app) return renderNoApps();
  shell('<div class="empty">Cargando…</div>');
  const main = root.querySelector('.main');
  try {
    await (VIEWS[state.view] || VIEWS.overview)(main);
  } catch (err) {
    main.innerHTML = `<div class="card"><div class="empty"><span class="icon">⚠️</span>${esc(err.message)}</div></div>`;
  }
}

// ---------------------------------------------------------------------------
// Vista: resumen
// ---------------------------------------------------------------------------
VIEWS.overview = async (main) => {
  const days = Number(localStorage.getItem('pf:days') || 30);
  const [overview, countries, browsers, top] = await Promise.all([
    api(`/apps/${state.app.id}/overview?days=${days}`),
    api(`/apps/${state.app.id}/breakdown/country`),
    api(`/apps/${state.app.id}/breakdown/browser`),
    api(`/apps/${state.app.id}/notifications?limit=5&status=sent`),
  ]);
  const { audience, totals, series } = overview;

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Resumen</h1><p>${esc(state.app.name)} · últimos ${days} días</p></div>
      <div class="flex">
        <select id="range" style="width:auto">
          ${[7, 30, 90, 365].map((d) => `<option value="${d}"${d === days ? ' selected' : ''}>Últimos ${d} días</option>`).join('')}
        </select>
        <button data-view="compose">Nueva notificación</button>
      </div>
    </div>

    <div class="grid grid-4 mb">
      <div class="stat"><div class="label">Suscriptores activos</div>
        <div class="value">${formatNumber(audience.active)}</div>
        <div class="sub">${formatNumber(audience.web)} web · ${formatNumber(audience.android)} Android</div></div>
      <div class="stat"><div class="label">Nuevos (24 h)</div>
        <div class="value">${formatNumber(audience.new_24h)}</div>
        <div class="sub">${formatNumber(audience.unsubscribed)} bajas acumuladas</div></div>
      <div class="stat"><div class="label">Notificaciones entregadas</div>
        <div class="value">${formatNumber(totals.delivered)}</div>
        <div class="sub">de ${formatNumber(totals.sent)} enviadas (${formatPercent(totals.delivery_rate)})</div></div>
      <div class="stat"><div class="label">Tasa de clics</div>
        <div class="value">${formatPercent(totals.ctr)}</div>
        <div class="sub">${formatNumber(totals.clicked)} clics · ${formatNumber(totals.outcomes)} conversiones</div></div>
    </div>

    <div class="card mb">
      <div class="card-head"><h2>Actividad de envío</h2>
        <span class="small muted">Enviadas, entregadas y clics por día</span></div>
      <div id="chart-activity"></div>
    </div>

    <div class="grid grid-2 mb">
      <div class="card"><div class="card-head"><h3>Crecimiento de la audiencia</h3></div>
        <div id="chart-growth"></div></div>
      <div class="card"><div class="card-head"><h3>Por país</h3></div>
        <div id="chart-country"></div></div>
    </div>

    <div class="grid grid-2">
      <div class="card"><div class="card-head"><h3>Por navegador y plataforma</h3></div>
        <div id="chart-browser"></div></div>
      <div class="card">
        <div class="card-head"><h3>Últimas notificaciones</h3>
          <button class="btn-ghost btn-sm" data-view="notifications">Ver todas</button></div>
        ${top.notifications.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Mensaje</th><th class="num">Entregadas</th><th class="num">CTR</th></tr></thead>
          <tbody>${top.notifications.map((n) => `<tr>
            <td>${esc(firstText(n.headings) || firstText(n.contents)).slice(0, 42)}</td>
            <td class="num">${formatNumber(n.received)}</td>
            <td class="num">${formatPercent(n.ctr)}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty small">Todavía no has enviado ninguna notificación.</div>'}
      </div>
    </div>`;

  const growth = await api(`/apps/${state.app.id}/growth?days=${days}`);
  const draw = () => {
    lineChart(main.querySelector('#chart-activity'), [
      { name: 'Enviadas', color: seriesColor(0), values: series.map((r) => ({ x: r.day, y: r.sent })) },
      { name: 'Entregadas', color: seriesColor(1), values: series.map((r) => ({ x: r.day, y: r.delivered })) },
      { name: 'Clics', color: seriesColor(2), values: series.map((r) => ({ x: r.day, y: r.clicked })) },
    ], { height: 250, ariaLabel: 'Envíos, entregas y clics por día' });

    lineChart(main.querySelector('#chart-growth'), [
      { name: 'Altas', color: seriesColor(0), values: growth.series.map((r) => ({ x: r.day, y: r.added })) },
      { name: 'Bajas', color: seriesColor(1), values: growth.series.map((r) => ({ x: r.day, y: r.removed })) },
    ], { height: 200, ariaLabel: 'Altas y bajas de suscriptores por día' });

    barChart(main.querySelector('#chart-country'), countries.data, { limit: 8 });
    barChart(main.querySelector('#chart-browser'), browsers.data, { limit: 8 });
  };
  draw();
  onResize(draw);

  main.querySelector('#range').addEventListener('change', (event) => {
    localStorage.setItem('pf:days', event.target.value);
    render();
  });
  bind('[data-view]', 'click', (event) => go(event.currentTarget.dataset.view));
};

// ---------------------------------------------------------------------------
// Vista: componer notificación
// ---------------------------------------------------------------------------
VIEWS.compose = async (main) => {
  const [{ segments }, { templates }] = await Promise.all([
    api(`/apps/${state.app.id}/segments`),
    api(`/apps/${state.app.id}/templates`),
  ]);

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Nueva notificación</h1><p>Se enviará a los dispositivos que coincidan con la segmentación.</p></div>
    </div>
    <form id="compose" class="grid grid-2" style="align-items:start">
      <div>
        <div class="card">
          <div class="card-head"><h2>Contenido</h2>
            ${templates.length ? `<select id="template" style="width:auto">
              <option value="">Sin plantilla</option>
              ${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
            </select>` : ''}</div>

          <div class="field">
            <label for="title">Título <span class="muted">(admite emojis)</span></label>
            <input id="title" name="title" maxlength="120" placeholder="🎉 ¡Tenemos novedades!">
          </div>
          <div class="field">
            <label for="message">Mensaje *</label>
            <textarea id="message" name="message" required maxlength="500"
              placeholder="Escribe aquí el texto. Puedes usar {{nombre}} para personalizar con tags."></textarea>
            <div class="hint">Personalización: <code>{{tags.nombre|amigo}}</code>, <code>{{external_id}}</code>.</div>
          </div>
          <div class="field">
            <label for="url">Al pulsar, abrir</label>
            <input id="url" name="url" type="url" placeholder="https://tusitio.com/oferta">
            <div class="hint">Para la APK puedes usar un deep link propio en «Opciones avanzadas».</div>
          </div>
          <div class="row">
            <div class="field"><label for="image_url">Imagen grande</label>
              <input id="image_url" name="image_url" type="url" placeholder="https://…/banner.jpg"></div>
            <div class="field"><label for="icon_url">Icono</label>
              <input id="icon_url" name="icon_url" type="url" placeholder="https://…/icono.png"></div>
          </div>

          <details class="mt">
            <summary style="cursor:pointer;font-weight:600;font-size:13.5px">Botones de acción (hasta 3)</summary>
            <div id="buttons" class="mt"></div>
            <button type="button" class="btn-ghost btn-sm" id="add-button">+ Añadir botón</button>
          </details>

          <details class="mt">
            <summary style="cursor:pointer;font-weight:600;font-size:13.5px">Opciones avanzadas</summary>
            <div class="mt">
              <div class="row">
                <div class="field"><label for="app_url">Deep link (APK)</label>
                  <input id="app_url" name="app_url" placeholder="miapp://pantalla/42"></div>
                <div class="field"><label for="android_channel_id">Canal Android</label>
                  <input id="android_channel_id" name="android_channel_id" placeholder="ofertas"></div>
              </div>
              <div class="row">
                <div class="field"><label for="ttl">Validez (segundos)</label>
                  <input id="ttl" name="ttl" type="number" value="259200" min="0"></div>
                <div class="field"><label for="collapse_id">Agrupar por (collapse id)</label>
                  <input id="collapse_id" name="collapse_id" placeholder="promo-verano"></div>
              </div>
              <div class="field"><label for="data">Datos adicionales (JSON)</label>
                <textarea id="data" name="data" placeholder='{"pedido_id": 42}'></textarea></div>
              <div class="check"><input type="checkbox" id="require_interaction" name="require_interaction">
                <label for="require_interaction">Mantener visible hasta que el usuario interactúe</label></div>
            </div>
          </details>
        </div>

        <div class="card">
          <div class="card-head"><h2>Segmentación</h2>
            <span class="tag info" id="estimate">Calculando…</span></div>
          <div class="field">
            <label for="target">Enviar a</label>
            <select id="target" name="target">
              <option value="all">Todos los suscriptores</option>
              ${segments.map((s) => `<option value="seg:${s.id}">Segmento: ${esc(s.name)}${s.cached_count != null ? ` (${formatNumber(s.cached_count)})` : ''}</option>`).join('')}
              <option value="external">Usuarios concretos (external_user_id)</option>
            </select>
          </div>
          <div class="field" id="external-wrap" style="display:none">
            <label for="external_ids">Identificadores, separados por comas</label>
            <input id="external_ids" name="external_ids" placeholder="usuario-1, usuario-2">
          </div>
          <div class="field">
            <label>Canales</label>
            <div class="check"><input type="checkbox" id="ch_web" checked><label for="ch_web">Web (navegadores)</label></div>
            <div class="check"><input type="checkbox" id="ch_android" checked><label for="ch_android">Android (APK)</label></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Entrega</h2></div>
          <div class="field">
            <label for="when">Cuándo</label>
            <select id="when" name="when">
              <option value="now">Ahora mismo</option>
              <option value="scheduled">En una fecha concreta</option>
              <option value="timezone">A una hora local del usuario</option>
            </select>
          </div>
          <div class="field" id="when-date" style="display:none">
            <label for="send_after">Fecha y hora</label>
            <input id="send_after" name="send_after" type="datetime-local">
          </div>
          <div class="field" id="when-tod" style="display:none">
            <label for="delivery_time_of_day">Hora local del destinatario</label>
            <input id="delivery_time_of_day" name="delivery_time_of_day" type="time" value="09:00">
          </div>
          <div class="check"><input type="checkbox" id="ab" name="ab">
            <label for="ab">Probar dos versiones (test A/B)</label></div>
          <div id="ab-wrap" style="display:none">
            <div class="field"><label for="title_b">Título — versión B</label>
              <input id="title_b" name="title_b"></div>
            <div class="field"><label for="message_b">Mensaje — versión B</label>
              <textarea id="message_b" name="message_b"></textarea></div>
          </div>
        </div>
      </div>

      <div>
        <div class="card" style="position:sticky;top:20px">
          <div class="card-head"><h2>Vista previa</h2></div>
          <div class="preview"><div class="preview-note" id="preview"></div></div>
          <div class="mt flex">
            <button type="submit" id="send-btn">Enviar notificación</button>
            <button type="button" class="btn-ghost" id="test-btn">Enviar prueba</button>
          </div>
          <p class="small muted mt">La prueba se envía solo a los dispositivos marcados como
            «usuario de prueba» (test_type = 2).</p>
        </div>
      </div>
    </form>`;

  const form = main.querySelector('#compose');
  const preview = main.querySelector('#preview');

  function buttonRows() {
    return [...main.querySelectorAll('#buttons .btn-row')].map((row, index) => ({
      id: row.querySelector('.b-id').value || `btn${index}`,
      text: row.querySelector('.b-text').value,
      url: row.querySelector('.b-url').value || null,
    })).filter((b) => b.text);
  }

  function drawPreview() {
    const title = form.title.value || 'Título de la notificación';
    const message = form.message.value || 'Aquí aparecerá el mensaje.';
    const image = form.image_url.value;
    const icon = form.icon_url.value || state.app.default_icon_url;
    const buttons = buttonRows();
    preview.innerHTML = `
      <div class="pn-head">
        ${icon ? `<img class="pn-icon" src="${esc(icon)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'pn-icon',textContent:'🔔'}))">`
               : '<div class="pn-icon">🔔</div>'}
        <div style="min-width:0">
          <div class="pn-title">${esc(title)}</div>
          <div class="pn-body">${esc(message)}</div>
          <div class="pn-site">${esc((state.app.site_url || location.origin).replace(/^https?:\/\//, ''))}</div>
        </div>
      </div>
      ${image ? `<img class="pn-image" src="${esc(image)}" alt="" onerror="this.remove()">` : ''}
      ${buttons.length ? `<div class="pn-actions">${buttons.map((b) => `<button type="button">${esc(b.text)}</button>`).join('')}</div>` : ''}`;
  }

  function targetPayload() {
    const target = form.target.value;
    const channels = [];
    if (main.querySelector('#ch_web').checked) channels.push('web_push');
    if (main.querySelector('#ch_android').checked) channels.push('android');
    const payload = { channels };
    if (target.startsWith('seg:')) payload.included_segments = [target.slice(4)];
    else if (target === 'external') {
      payload.include_external_user_ids = form.external_ids.value.split(',')
        .map((s) => s.trim()).filter(Boolean);
    } else payload.include_all = true;
    return payload;
  }

  async function updateEstimate() {
    const badge = main.querySelector('#estimate');
    try {
      const payload = targetPayload();
      const result = await api(`/apps/${state.app.id}/estimate`, { method: 'POST', body: {
        target_type: payload.included_segments ? 'segments'
          : payload.include_external_user_ids ? 'external_ids' : 'all',
        included_segments: payload.included_segments || [],
        include_external_user_ids: payload.include_external_user_ids || [],
        channels: payload.channels,
      } });
      badge.textContent = `${formatNumber(result.estimated_recipients)} destinatarios`;
    } catch { badge.textContent = '—'; }
  }

  function payload() {
    const body = {
      title: form.title.value || undefined,
      message: form.message.value,
      url: form.url.value || undefined,
      app_url: form.app_url.value || undefined,
      image_url: form.image_url.value || undefined,
      icon_url: form.icon_url.value || undefined,
      android_channel_id: form.android_channel_id.value || undefined,
      collapse_id: form.collapse_id.value || undefined,
      ttl: Number(form.ttl.value) || undefined,
      require_interaction: form.require_interaction.checked,
      buttons: buttonRows(),
      ...targetPayload(),
    };
    if (form.data.value.trim()) {
      try { body.data = JSON.parse(form.data.value); }
      catch { throw new Error('Los datos adicionales no son un JSON válido'); }
    }
    const when = form.when.value;
    if (when === 'scheduled' && form.send_after.value) {
      body.send_after = new Date(form.send_after.value).toISOString();
    } else if (when === 'timezone') {
      body.delayed_option = 'timezone';
      body.delivery_time_of_day = form.delivery_time_of_day.value;
    }
    if (form.ab.checked && form.message_b.value) {
      body.ab_test = { variants: [
        { id: 'A', weight: 50, headings: { es: form.title.value }, contents: { es: form.message.value } },
        { id: 'B', weight: 50, headings: { es: form.title_b.value || form.title.value },
          contents: { es: form.message_b.value } },
      ] };
    }
    return body;
  }

  main.querySelector('#add-button').addEventListener('click', () => {
    const container = main.querySelector('#buttons');
    if (container.children.length >= 3) return;
    const row = document.createElement('div');
    row.className = 'btn-row row mb';
    row.innerHTML = `<input class="b-text" placeholder="Texto del botón" style="flex:2">
      <input class="b-url" placeholder="URL (opcional)" style="flex:3">
      <input class="b-id" placeholder="id" style="flex:1">
      <button type="button" class="btn-ghost btn-sm" style="flex:0">✕</button>`;
    row.querySelector('button').addEventListener('click', () => { row.remove(); drawPreview(); });
    row.addEventListener('input', drawPreview);
    container.appendChild(row);
  });

  form.addEventListener('input', drawPreview);
  form.target.addEventListener('change', () => {
    main.querySelector('#external-wrap').style.display =
      form.target.value === 'external' ? '' : 'none';
    updateEstimate();
  });
  main.querySelector('#ch_web').addEventListener('change', updateEstimate);
  main.querySelector('#ch_android').addEventListener('change', updateEstimate);
  form.when.addEventListener('change', () => {
    main.querySelector('#when-date').style.display = form.when.value === 'scheduled' ? '' : 'none';
    main.querySelector('#when-tod').style.display = form.when.value === 'timezone' ? '' : 'none';
  });
  form.ab.addEventListener('change', () => {
    main.querySelector('#ab-wrap').style.display = form.ab.checked ? '' : 'none';
  });
  main.querySelector('#template')?.addEventListener('change', async (event) => {
    if (!event.target.value) return;
    const template = templates.find((t) => t.id === event.target.value);
    const data = template?.payload || {};
    form.title.value = firstText(data.headings) || data.title || '';
    form.message.value = firstText(data.contents) || data.message || '';
    form.url.value = data.url || '';
    form.image_url.value = data.image_url || data.big_picture || '';
    drawPreview();
  });

  main.querySelector('#test-btn').addEventListener('click', async () => {
    try {
      const body = { ...payload(), include_all: undefined, included_segments: undefined,
        filters: [{ field: 'test_type', relation: '=', value: 2 }], name: 'prueba' };
      const result = await api(`/apps/${state.app.id}/notifications`, { method: 'POST', body });
      toast(`Prueba enviada (${result.notification.id.slice(0, 8)}…)`);
    } catch (err) { toast(err.message, true); }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = main.querySelector('#send-btn');
    button.disabled = true;
    try {
      const result = await api(`/apps/${state.app.id}/notifications`,
        { method: 'POST', body: payload() });
      toast(result.notification.status === 'scheduled'
        ? 'Notificación programada correctamente'
        : 'Notificación en cola de envío');
      go('notifications');
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
    }
  });

  drawPreview();
  updateEstimate();
};

// ---------------------------------------------------------------------------
// Vista: historial e informe de una notificación
// ---------------------------------------------------------------------------
VIEWS.notifications = async (main) => {
  const detailId = state.data.notificationId;
  if (detailId) return renderNotificationReport(main, detailId);

  const { notifications, total } = await api(`/apps/${state.app.id}/notifications?limit=50`);
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Historial</h1><p>${formatNumber(total)} notificaciones</p></div>
      <button data-view="compose">Nueva notificación</button>
    </div>
    <div class="card">
      ${notifications.length ? `<div class="table-wrap"><table>
        <thead><tr>
          <th>Mensaje</th><th>Estado</th><th class="num">Destinatarios</th>
          <th class="num">Entregadas</th><th class="num">Clics</th><th class="num">CTR</th>
          <th>Fecha</th><th></th>
        </tr></thead>
        <tbody>${notifications.map((n) => `<tr>
          <td><div style="font-weight:600">${esc(firstText(n.headings) || '(sin título)').slice(0, 46)}</div>
              <div class="small muted">${esc(firstText(n.contents)).slice(0, 60)}</div></td>
          <td>${statusTag(n.status)}</td>
          <td class="num">${formatNumber(n.recipients)}</td>
          <td class="num">${formatNumber(n.received)}</td>
          <td class="num">${formatNumber(n.clicked)}</td>
          <td class="num">${formatPercent(n.ctr)}</td>
          <td class="small muted">${dateTime(n.completed_at || n.send_after || n.created_at)}</td>
          <td><button class="btn-ghost btn-sm" data-report="${n.id}">Ver</button>
            ${['scheduled', 'queued', 'sending'].includes(n.status)
              ? `<button class="btn-ghost btn-sm" data-cancel="${n.id}">Cancelar</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty"><span class="icon">📭</span>Todavía no has enviado ninguna notificación.</div>'}
    </div>`;

  bind('[data-view]', 'click', (event) => go(event.currentTarget.dataset.view));
  bind('[data-report]', 'click', (event) => {
    state.data.notificationId = event.currentTarget.dataset.report;
    render();
  });
  bind('[data-cancel]', 'click', async (event) => {
    if (!confirm('¿Cancelar esta notificación? No se enviará a los destinatarios pendientes.')) return;
    try {
      await api(`/apps/${state.app.id}/notifications/${event.currentTarget.dataset.cancel}`,
        { method: 'DELETE' });
      toast('Notificación cancelada'); render();
    } catch (err) { toast(err.message, true); }
  });
};

async function renderNotificationReport(main, id) {
  const report = await api(`/apps/${state.app.id}/notifications/${id}`);
  const { notification: n, stats, hourly, by_variant: variants, by_country: countries,
          by_action: actions, errors } = report;

  main.innerHTML = `
    <div class="page-head">
      <div>
        <button class="btn-ghost btn-sm mb" id="back">← Volver al historial</button>
        <h1>${esc(firstText(n.headings) || '(sin título)')}</h1>
        <p>${esc(firstText(n.contents))}</p>
      </div>
      <div style="text-align:right">${statusTag(n.status)}
        <div class="small muted mt">${dateTime(n.completed_at || n.created_at)}</div></div>
    </div>

    <div class="grid grid-4 mb">
      <div class="stat"><div class="label">Destinatarios</div>
        <div class="value">${formatNumber(stats.recipients)}</div>
        <div class="sub">${formatNumber(stats.sent)} aceptadas por el proveedor</div></div>
      <div class="stat"><div class="label">Entregadas</div>
        <div class="value">${formatNumber(stats.delivered)}</div>
        <div class="sub">${formatPercent(stats.delivery_rate)} de las enviadas</div></div>
      <div class="stat"><div class="label">Clics</div>
        <div class="value">${formatNumber(stats.clicked)}</div>
        <div class="sub">CTR ${formatPercent(stats.ctr)}</div></div>
      <div class="stat"><div class="label">Conversiones</div>
        <div class="value">${formatNumber(stats.converted)}</div>
        <div class="sub">${formatNumber(stats.dismissed)} descartadas · ${formatNumber(stats.failed)} fallidas</div></div>
    </div>

    ${hourly.length ? `<div class="card mb">
      <div class="card-head"><h2>Evolución por hora</h2></div>
      <div id="chart-hourly"></div></div>` : ''}

    <div class="grid grid-2">
      ${variants.length > 1 ? `<div class="card">
        <div class="card-head"><h3>Comparativa A/B</h3>
          <button class="btn-sm" id="pick-winner">Enviar la ganadora al resto</button></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Versión</th><th class="num">Enviadas</th><th class="num">Entregadas</th>
            <th class="num">Clics</th><th class="num">CTR</th></tr></thead>
          <tbody>${variants.map((v) => `<tr>
            <td><b>${esc(v.variant)}</b></td>
            <td class="num">${formatNumber(v.sent)}</td>
            <td class="num">${formatNumber(v.delivered)}</td>
            <td class="num">${formatNumber(v.clicked)}</td>
            <td class="num">${formatPercent(v.delivered > 0 ? v.clicked / v.delivered : 0)}</td>
          </tr>`).join('')}</tbody></table></div></div>` : ''}

      ${actions.length ? `<div class="card">
        <div class="card-head"><h3>Clics por botón</h3></div>
        <div id="chart-actions"></div></div>` : ''}

      <div class="card"><div class="card-head"><h3>Clics por país</h3></div>
        <div id="chart-countries"></div></div>

      ${errors.length ? `<div class="card">
        <div class="card-head"><h3>Errores de entrega</h3></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Código</th><th class="num">Casos</th><th>Ejemplo</th></tr></thead>
          <tbody>${errors.map((e) => `<tr><td><code>${esc(e.error_code)}</code></td>
            <td class="num">${formatNumber(e.n)}</td>
            <td class="small muted">${esc(e.sample || '').slice(0, 60)}</td></tr>`).join('')}</tbody>
        </table></div></div>` : ''}
    </div>`;

  main.querySelector('#back').addEventListener('click', () => {
    state.data.notificationId = null; render();
  });

  const draw = () => {
    if (hourly.length) {
      lineChart(main.querySelector('#chart-hourly'), [
        { name: 'Enviadas', color: seriesColor(0), values: hourly.map((h) => ({ x: h.hour, y: h.sent })) },
        { name: 'Entregadas', color: seriesColor(1), values: hourly.map((h) => ({ x: h.hour, y: h.delivered })) },
        { name: 'Clics', color: seriesColor(2), values: hourly.map((h) => ({ x: h.hour, y: h.clicked })) },
      ], { height: 220 });
    }
    if (actions.length) {
      barChart(main.querySelector('#chart-actions'),
        actions.map((a) => ({ label: a.action, value: a.clicks })), { measure: 'Clics' });
    }
    barChart(main.querySelector('#chart-countries'),
      countries.map((c) => ({ label: c.label, value: c.clicked,
        extra: { label: 'Enviadas', value: formatNumber(c.sent) } })),
      { measure: 'Clics', limit: 8 });
  };
  draw();
  onResize(draw);

  main.querySelector('#pick-winner')?.addEventListener('click', async () => {
    if (!confirm('Se enviará la versión con mejor CTR al resto de la audiencia. ¿Continuar?')) return;
    try {
      const result = await api(`/apps/${state.app.id}/notifications/${id}/winner`, { method: 'POST' });
      toast(`Enviando la versión ${result.winner} al resto de la audiencia`);
    } catch (err) { toast(err.message, true); }
  });
}

// ---------------------------------------------------------------------------
// Vista: audiencia
// ---------------------------------------------------------------------------
VIEWS.audience = async (main) => {
  const filters = state.data.audience || { search: '', channel: '', status: 'active', offset: 0 };
  state.data.audience = filters;
  const query = new URLSearchParams({
    limit: 50, offset: filters.offset,
    ...(filters.search ? { search: filters.search } : {}),
    ...(filters.channel ? { channel: filters.channel } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  });
  const { subscriptions, total } = await api(`/apps/${state.app.id}/subscriptions?${query}`);

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Suscriptores</h1><p>${formatNumber(total)} dispositivos</p></div>
      <button class="btn-ghost" id="export">Exportar CSV</button>
    </div>
    <div class="card mb">
      <div class="row">
        <input id="search" placeholder="Buscar por ID, usuario, país o modelo" value="${esc(filters.search)}">
        <select id="channel" style="max-width:180px">
          <option value="">Todos los canales</option>
          <option value="web_push"${filters.channel === 'web_push' ? ' selected' : ''}>Web</option>
          <option value="android"${filters.channel === 'android' ? ' selected' : ''}>Android</option>
        </select>
        <select id="status" style="max-width:180px">
          <option value="active"${filters.status === 'active' ? ' selected' : ''}>Activos</option>
          <option value="unsubscribed"${filters.status === 'unsubscribed' ? ' selected' : ''}>Dados de baja</option>
          <option value="invalid"${filters.status === 'invalid' ? ' selected' : ''}>No válidos</option>
          <option value="">Todos</option>
        </select>
      </div>
    </div>
    <div class="card">
      ${subscriptions.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Dispositivo</th><th>Usuario</th><th>Ubicación</th><th>Tags</th>
          <th class="num">Sesiones</th><th>Última visita</th><th>Estado</th></tr></thead>
        <tbody>${subscriptions.map((s) => `<tr>
          <td><div>${s.channel === 'android' ? '📱 Android' : `🌐 ${esc(s.browser_name || 'Navegador')}`}</div>
              <div class="small muted mono">${s.id.slice(0, 8)}…</div></td>
          <td class="small">${esc(s.external_user_id || '—')}</td>
          <td class="small">${esc([s.city, s.country].filter(Boolean).join(', ') || '—')}
              <div class="small muted">${esc(s.language || '')}</div></td>
          <td class="small">${Object.entries(s.tags || {}).slice(0, 3)
            .map(([k, v]) => `<span class="tag">${esc(k)}: ${esc(v)}</span>`).join(' ') || '—'}</td>
          <td class="num">${formatNumber(s.session_count)}</td>
          <td class="small muted">${dateTime(s.last_seen_at)}</td>
          <td>${s.invalid ? '<span class="tag err">No válido</span>'
            : s.subscribed && !s.opted_out ? '<span class="tag ok">Activo</span>'
            : '<span class="tag">Baja</span>'}</td>
        </tr>`).join('')}</tbody></table></div>
        <div class="flex-between mt">
          <span class="small muted">Mostrando ${filters.offset + 1}–${filters.offset + subscriptions.length} de ${formatNumber(total)}</span>
          <div class="flex">
            <button class="btn-ghost btn-sm" id="prev"${filters.offset === 0 ? ' disabled' : ''}>Anterior</button>
            <button class="btn-ghost btn-sm" id="next"${filters.offset + 50 >= total ? ' disabled' : ''}>Siguiente</button>
          </div>
        </div>`
      : '<div class="empty"><span class="icon">👥</span>Aún no hay suscriptores. Revisa la pestaña «Instalación».</div>'}
    </div>`;

  let debounce;
  main.querySelector('#search').addEventListener('input', (event) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      filters.search = event.target.value; filters.offset = 0; render();
    }, 350);
  });
  main.querySelector('#channel').addEventListener('change', (event) => {
    filters.channel = event.target.value; filters.offset = 0; render();
  });
  main.querySelector('#status').addEventListener('change', (event) => {
    filters.status = event.target.value; filters.offset = 0; render();
  });
  main.querySelector('#prev')?.addEventListener('click', () => {
    filters.offset = Math.max(0, filters.offset - 50); render();
  });
  main.querySelector('#next')?.addEventListener('click', () => {
    filters.offset += 50; render();
  });
  main.querySelector('#export').addEventListener('click', () => {
    toast('Usa la API: POST /api/v1/exports con {"kind":"subscriptions"}');
  });
};

// ---------------------------------------------------------------------------
// Vista: segmentos
// ---------------------------------------------------------------------------
const FILTER_FIELDS = [
  { value: 'tag', label: 'Tag personalizado' },
  { value: 'country', label: 'País' },
  { value: 'language', label: 'Idioma' },
  { value: 'channel', label: 'Canal' },
  { value: 'session_count', label: 'Número de sesiones' },
  { value: 'last_session', label: 'Última visita (horas)' },
  { value: 'first_session', label: 'Primera visita (horas)' },
  { value: 'browser_name', label: 'Navegador' },
  { value: 'device_os', label: 'Sistema operativo' },
  { value: 'app_version', label: 'Versión de la app' },
  { value: 'city', label: 'Ciudad' },
];

VIEWS.segments = async (main) => {
  const { segments } = await api(`/apps/${state.app.id}/segments`);
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Segmentos</h1><p>Grupos de suscriptores definidos por reglas.</p></div>
      <button id="new-segment">Nuevo segmento</button>
    </div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Nombre</th><th>Reglas</th><th class="num">Dispositivos</th><th></th></tr></thead>
        <tbody>${segments.map((s) => `<tr>
          <td><b>${esc(s.name)}</b>${s.is_system ? ' <span class="tag">sistema</span>' : ''}
              ${s.description ? `<div class="small muted">${esc(s.description)}</div>` : ''}</td>
          <td class="small muted">${describeFilters(s.filters)}</td>
          <td class="num">${s.cached_count != null ? formatNumber(s.cached_count) : '—'}</td>
          <td>${s.is_system ? '' : `<button class="btn-ghost btn-sm" data-del-seg="${s.id}">Eliminar</button>`}</td>
        </tr>`).join('')}</tbody></table></div>
    </div>
    <div class="card" id="segment-form" style="display:none">
      <div class="card-head"><h2>Nuevo segmento</h2>
        <span class="tag info" id="seg-count">—</span></div>
      <div class="field"><label for="seg-name">Nombre</label>
        <input id="seg-name" placeholder="Clientes VIP de México"></div>
      <div id="rules"></div>
      <div class="flex mt">
        <button type="button" class="btn-ghost btn-sm" id="add-rule">+ Añadir regla</button>
        <button type="button" class="btn-ghost btn-sm" id="add-or">+ Añadir grupo «o bien»</button>
      </div>
      <div class="flex mt"><button id="save-segment">Guardar segmento</button>
        <button class="btn-ghost" id="cancel-segment">Cancelar</button></div>
    </div>`;

  const formCard = main.querySelector('#segment-form');
  const rules = main.querySelector('#rules');

  function addRule() {
    const row = document.createElement('div');
    row.className = 'row mb rule';
    row.innerHTML = `
      <select class="r-field" style="flex:2">${FILTER_FIELDS.map((f) =>
        `<option value="${f.value}">${f.label}</option>`).join('')}</select>
      <input class="r-key" placeholder="clave del tag" style="flex:1;display:none">
      <select class="r-rel" style="flex:0;min-width:90px">
        <option value="=">es igual a</option><option value="!=">no es</option>
        <option value=">">mayor que</option><option value="<">menor que</option>
        <option value="exists">existe</option><option value="not_exists">no existe</option>
      </select>
      <input class="r-value" placeholder="valor" style="flex:2">
      <button type="button" class="btn-ghost btn-sm" style="flex:0">✕</button>`;
    const fieldSelect = row.querySelector('.r-field');
    fieldSelect.addEventListener('change', () => {
      row.querySelector('.r-key').style.display = fieldSelect.value === 'tag' ? '' : 'none';
      preview();
    });
    row.querySelector('button').addEventListener('click', () => { row.remove(); preview(); });
    row.addEventListener('input', preview);
    row.addEventListener('change', preview);
    rules.appendChild(row);
  }

  function addOr() {
    const separator = document.createElement('div');
    separator.className = 'mb or-sep';
    separator.innerHTML = '<span class="tag">o bien…</span>';
    rules.appendChild(separator);
    addRule();
  }

  function collect() {
    const filters = [];
    [...rules.children].forEach((node) => {
      if (node.classList.contains('or-sep')) { filters.push({ operator: 'OR' }); return; }
      const field = node.querySelector('.r-field').value;
      const relation = node.querySelector('.r-rel').value;
      const value = node.querySelector('.r-value').value;
      const key = node.querySelector('.r-key').value;
      if (field === 'tag' && !key) return;
      const filter = { field, relation };
      if (field === 'tag') filter.key = key;
      if (['last_session', 'first_session'].includes(field)) filter.hours_ago = value;
      else if (!['exists', 'not_exists'].includes(relation)) filter.value = value;
      filters.push(filter);
    });
    return filters;
  }

  let previewTimer;
  function preview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const badge = main.querySelector('#seg-count');
      try {
        const result = await api(`/apps/${state.app.id}/estimate`,
          { method: 'POST', body: { target_type: 'filters', filters: collect() } });
        badge.textContent = `${formatNumber(result.estimated_recipients)} dispositivos`;
      } catch (err) { badge.textContent = 'reglas incompletas'; }
    }, 400);
  }

  main.querySelector('#new-segment').addEventListener('click', () => {
    formCard.style.display = ''; rules.innerHTML = ''; addRule();
    formCard.scrollIntoView({ behavior: 'smooth' });
  });
  main.querySelector('#cancel-segment').addEventListener('click', () => { formCard.style.display = 'none'; });
  main.querySelector('#add-rule').addEventListener('click', addRule);
  main.querySelector('#add-or').addEventListener('click', addOr);

  main.querySelector('#save-segment').addEventListener('click', async () => {
    const name = main.querySelector('#seg-name').value.trim();
    if (!name) return toast('Ponle un nombre al segmento', true);
    try {
      await fetchApiV1(`/segments`, { method: 'POST', body: { name, filters: collect() } });
      toast('Segmento guardado'); render();
    } catch (err) { toast(err.message, true); }
  });

  bind('[data-del-seg]', 'click', async (event) => {
    if (!confirm('¿Eliminar este segmento?')) return;
    try {
      await fetchApiV1(`/segments/${event.currentTarget.dataset.delSeg}`, { method: 'DELETE' });
      toast('Segmento eliminado'); render();
    } catch (err) { toast(err.message, true); }
  });
};

function describeFilters(filters) {
  if (!filters?.length) return 'Todos los suscriptores';
  return filters.map((f) => {
    if (f.operator) return '<b>o bien</b>';
    if (f.field === 'tag') return `${esc(f.key)} ${esc(f.relation)} ${esc(f.value ?? '')}`;
    if (f.hours_ago) return `${esc(f.field)} ${f.relation === '>' ? 'hace más de' : 'hace menos de'} ${esc(f.hours_ago)} h`;
    return `${esc(f.field)} ${esc(f.relation)} ${esc(Array.isArray(f.value) ? f.value.join('/') : f.value ?? '')}`;
  }).join(' y ');
}

// ---------------------------------------------------------------------------
// Vista: automatizaciones
// ---------------------------------------------------------------------------
const TRIGGER_LABELS = {
  subscription_created: 'Al suscribirse',
  event: 'Al recibir un evento',
  tag_changed: 'Al cambiar un tag',
  inactivity: 'Por inactividad',
  schedule: 'Programada (cron)',
};

VIEWS.automations = async (main) => {
  const { automations } = await api(`/apps/${state.app.id}/automations`);
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Automatizaciones</h1>
        <p>Secuencias que se disparan solas: bienvenida, carrito abandonado, reenganche…</p></div>
      <button id="new-auto">Nueva automatización</button>
    </div>
    <div class="card">
      ${automations.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Nombre</th><th>Disparador</th><th>Pasos</th><th class="num">Enviadas</th>
          <th>Estado</th><th></th></tr></thead>
        <tbody>${automations.map((a) => `<tr>
          <td><b>${esc(a.name)}</b></td>
          <td class="small">${TRIGGER_LABELS[a.trigger?.type] || esc(a.trigger?.type)}
            ${a.trigger?.event_name ? `<div class="small muted">${esc(a.trigger.event_name)}</div>` : ''}
            ${a.trigger?.cron ? `<div class="small muted mono">${esc(a.trigger.cron)}</div>` : ''}
            ${a.trigger?.inactive_days ? `<div class="small muted">${a.trigger.inactive_days} días</div>` : ''}</td>
          <td class="small muted">${(a.steps || []).map((s) => s.type).join(' → ')}</td>
          <td class="num">${formatNumber(a.stats?.sent || 0)}</td>
          <td>${a.status === 'active' ? '<span class="tag ok">Activa</span>' : '<span class="tag">Pausada</span>'}</td>
          <td><button class="btn-ghost btn-sm" data-toggle="${a.id}" data-status="${a.status}">
            ${a.status === 'active' ? 'Pausar' : 'Activar'}</button>
            <button class="btn-ghost btn-sm" data-del-auto="${a.id}">Eliminar</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty"><span class="icon">⚡</span>No hay automatizaciones todavía.</div>'}
    </div>

    <div class="card" id="auto-form" style="display:none">
      <div class="card-head"><h2>Nueva automatización</h2></div>
      <div class="row">
        <div class="field"><label for="a-name">Nombre</label>
          <input id="a-name" placeholder="Bienvenida"></div>
        <div class="field"><label for="a-trigger">Disparador</label>
          <select id="a-trigger">${Object.entries(TRIGGER_LABELS)
            .map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>
      </div>
      <div class="field" id="a-extra-wrap" style="display:none">
        <label for="a-extra">Detalle del disparador</label>
        <input id="a-extra" placeholder="nombre del evento / 0 9 * * 1 / 7">
      </div>
      <div class="row">
        <div class="field"><label for="a-wait">Esperar antes de enviar (minutos)</label>
          <input id="a-wait" type="number" value="0" min="0"></div>
      </div>
      <div class="field"><label for="a-title">Título del mensaje</label>
        <input id="a-title" placeholder="👋 ¡Gracias por suscribirte!"></div>
      <div class="field"><label for="a-message">Mensaje</label>
        <textarea id="a-message" placeholder="Te avisaremos de las mejores ofertas."></textarea></div>
      <div class="field"><label for="a-url">URL de destino</label>
        <input id="a-url" type="url" placeholder="https://tusitio.com"></div>
      <div class="flex mt"><button id="save-auto">Crear automatización</button>
        <button class="btn-ghost" id="cancel-auto">Cancelar</button></div>
    </div>`;

  const formCard = main.querySelector('#auto-form');
  const triggerSelect = main.querySelector('#a-trigger');
  const extraWrap = main.querySelector('#a-extra-wrap');

  main.querySelector('#new-auto').addEventListener('click', () => {
    formCard.style.display = ''; formCard.scrollIntoView({ behavior: 'smooth' });
  });
  main.querySelector('#cancel-auto').addEventListener('click', () => { formCard.style.display = 'none'; });
  triggerSelect.addEventListener('change', () => {
    extraWrap.style.display = ['event', 'schedule', 'inactivity'].includes(triggerSelect.value) ? '' : 'none';
  });

  main.querySelector('#save-auto').addEventListener('click', async () => {
    const name = main.querySelector('#a-name').value.trim();
    const message = main.querySelector('#a-message').value.trim();
    if (!name || !message) return toast('El nombre y el mensaje son obligatorios', true);

    const type = triggerSelect.value;
    const extra = main.querySelector('#a-extra').value.trim();
    const trigger = { type };
    if (type === 'event') trigger.event_name = extra;
    if (type === 'schedule') trigger.cron = extra || '0 9 * * *';
    if (type === 'inactivity') trigger.inactive_days = Number(extra) || 7;

    const wait = Number(main.querySelector('#a-wait').value) || 0;
    const steps = [];
    if (wait > 0) steps.push({ type: 'wait', minutes: wait });
    steps.push({ type: 'send', payload: {
      title: main.querySelector('#a-title').value || undefined,
      message,
      url: main.querySelector('#a-url').value || undefined,
    } });

    try {
      await fetchApiV1('/automations', { method: 'POST',
        body: { name, trigger, steps, status: 'active' } });
      toast('Automatización creada y activada'); render();
    } catch (err) { toast(err.message, true); }
  });

  bind('[data-toggle]', 'click', async (event) => {
    const { toggle, status } = event.currentTarget.dataset;
    try {
      await fetchApiV1(`/automations/${toggle}`, { method: 'PATCH',
        body: { status: status === 'active' ? 'paused' : 'active' } });
      render();
    } catch (err) { toast(err.message, true); }
  });
  bind('[data-del-auto]', 'click', async (event) => {
    if (!confirm('¿Eliminar esta automatización?')) return;
    try {
      await fetchApiV1(`/automations/${event.currentTarget.dataset.delAuto}`, { method: 'DELETE' });
      toast('Eliminada'); render();
    } catch (err) { toast(err.message, true); }
  });
};

// ---------------------------------------------------------------------------
// Vista: instalación (web y APK)
// ---------------------------------------------------------------------------
VIEWS.install = async (main) => {
  const info = await api(`/apps/${state.app.id}`);
  const app = info.app;
  const origin = location.origin;
  const tab = state.data.installTab || 'web';

  const webSnippet =
`<!-- Pega esto antes de </body> en todas las páginas -->
<script src="${origin}/sdk/v1/push.js" data-app-id="${app.id}" async></script>`;

  const swSnippet =
`// Fichero: /pushflow-sw.js  (en la raíz de tu dominio)
importScripts('${origin}/sdk/v1/pushflow-sw.js');`;

  const androidSnippet =
`// build.gradle (módulo :app)
implementation 'com.pushflow:pushflow-android:1.0.0'

// Application.onCreate()
PushFlow.init(
    context = this,
    appId   = "${app.id}",
    apiUrl  = "${origin}"
)`;

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Instalación</h1><p>Dos pasos para la web, uno para la APK.</p></div>
      <div class="flex">
        <button class="${tab === 'web' ? '' : 'btn-ghost'}" data-tab="web">Página web</button>
        <button class="${tab === 'android' ? '' : 'btn-ghost'}" data-tab="android">App Android (APK)</button>
      </div>
    </div>

    ${tab === 'web' ? `
      <div class="card mb">
        <div class="card-head"><h2>Paso 1 · Crea el service worker</h2></div>
        <p class="small muted mb">Sube un fichero llamado <code>pushflow-sw.js</code> a la
          <b>raíz</b> de tu dominio (accesible en <code>https://tudominio.com/pushflow-sw.js</code>)
          con este contenido. Es la única línea que necesita:</p>
        <div class="snippet">${esc(swSnippet)}</div>
        <button class="btn-ghost btn-sm mt" data-copy="${esc(swSnippet)}">Copiar</button>
        <a class="btn btn-ghost btn-sm mt" href="/sdk/v1/pushflow-sw.js" download="pushflow-sw.js">Descargar completo</a>
      </div>

      <div class="card mb">
        <div class="card-head"><h2>Paso 2 · Añade el script</h2></div>
        <p class="small muted mb">Una sola línea antes de <code>&lt;/body&gt;</code>. El prompt de
          permiso, el registro del dispositivo y la analítica funcionan solos.</p>
        <div class="snippet">${esc(webSnippet)}</div>
        <button class="btn-ghost btn-sm mt" data-copy="${esc(webSnippet)}">Copiar</button>
      </div>

      <div class="card mb">
        <div class="card-head"><h2>Comprobaciones</h2></div>
        <table>
          <tbody>
            <tr><td>Tu sitio usa HTTPS</td><td>${app.site_url?.startsWith('https://')
              ? '<span class="tag ok">Sí</span>' : '<span class="tag warn">Obligatorio para Web Push</span>'}</td></tr>
            <tr><td>Claves VAPID generadas</td><td>${app.vapid_public
              ? '<span class="tag ok">Listas</span>' : '<span class="tag err">Faltan</span>'}</td></tr>
            <tr><td>Orígenes autorizados</td><td class="mono small">${
              (app.allowed_origins || []).join(', ') || '<span class="tag warn">Sin restricción</span>'}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-head"><h2>API de JavaScript</h2></div>
        <div class="snippet">${esc(`// Identificar al usuario que ha iniciado sesión
PushFlow.setExternalUserId('usuario-123');

// Etiquetar para segmentar después
PushFlow.sendTags({ plan: 'pro', ciudad: 'CDMX' });

// Mostrar el prompt manualmente (por ejemplo, desde un botón)
PushFlow.showPrompt();

// Registrar una conversión atribuible a la notificación
PushFlow.addOutcome('compra', 49.90);

// Reaccionar a un clic en la notificación
PushFlow.on('notificationClick', (e) => console.log(e.url));`)}</div>
      </div>`
    : `
      <div class="card mb">
        <div class="card-head"><h2>Paso 1 · Sube las credenciales de Firebase</h2></div>
        <p class="small muted mb">Android entrega las notificaciones a través de FCM. En la consola de
          Firebase entra en <b>Configuración del proyecto → Cuentas de servicio →
          Generar nueva clave privada</b> y pega aquí el JSON descargado.</p>
        <div class="field">
          <textarea id="fcm-json" rows="6" placeholder='{"type":"service_account","project_id":"…"}'></textarea>
        </div>
        <div class="flex">
          <button id="save-fcm">Guardar credenciales</button>
          ${app.fcm_configured ? `<span class="tag ok">Configurado · ${esc(app.fcm_project_id)}</span>`
            : '<span class="tag warn">Sin configurar</span>'}
        </div>
      </div>

      <div class="card mb">
        <div class="card-head"><h2>Paso 2 · Añade el SDK a tu APK</h2></div>
        <div class="snippet">${esc(androidSnippet)}</div>
        <button class="btn-ghost btn-sm mt" data-copy="${esc(androidSnippet)}">Copiar</button>
        <p class="small muted mt">El SDK está en <code>android-sdk/</code> dentro del proyecto.
          Registra el token de FCM, muestra la notificación con imagen y botones, abre el deep
          link y reporta la analítica sin código adicional.</p>
      </div>

      <div class="card">
        <div class="card-head"><h2>API de Kotlin</h2></div>
        <div class="snippet">${esc(`PushFlow.setExternalUserId("usuario-123")
PushFlow.sendTags(mapOf("plan" to "pro"))
PushFlow.addOutcome("compra", 49.90)

PushFlow.setNotificationOpenedHandler { data ->
    // data["pf_url"], data["pf_data"]…
}`)}</div>
      </div>`}`;

  bind('[data-tab]', 'click', (event) => {
    state.data.installTab = event.currentTarget.dataset.tab; render();
  });
  bind('[data-copy]', 'click', (event) => {
    navigator.clipboard.writeText(event.currentTarget.dataset.copy);
    toast('Copiado al portapapeles');
  });
  main.querySelector('#save-fcm')?.addEventListener('click', async () => {
    const raw = main.querySelector('#fcm-json').value.trim();
    if (!raw) return toast('Pega el JSON de la cuenta de servicio', true);
    try {
      const result = await api(`/apps/${state.app.id}/fcm`, { method: 'POST',
        body: { service_account_json: raw } });
      toast(`Credenciales válidas · proyecto ${result.project_id}`);
      render();
    } catch (err) { toast(err.message, true); }
  });
};

// ---------------------------------------------------------------------------
// Vista: ajustes
// ---------------------------------------------------------------------------
VIEWS.settings = async (main) => {
  const [info, keys, system] = await Promise.all([
    api(`/apps/${state.app.id}`),
    api(`/apps/${state.app.id}/keys`),
    api('/system'),
  ]);
  const app = info.app;
  const settings = app.settings || {};
  const prompt = settings.prompt || {};
  const quiet = settings.quiet_hours || {};
  const cap = settings.frequency_cap || {};
  const welcome = settings.welcome_notification || {};

  main.innerHTML = `
    <div class="page-head"><div><h1>Ajustes</h1><p>${esc(app.name)}</p></div></div>

    <div class="grid grid-2">
      <div>
        <div class="card">
          <div class="card-head"><h2>Aplicación</h2></div>
          <div class="field"><label for="s-name">Nombre</label>
            <input id="s-name" value="${esc(app.name)}"></div>
          <div class="field"><label for="s-site">URL del sitio</label>
            <input id="s-site" type="url" value="${esc(app.site_url || '')}"></div>
          <div class="field"><label for="s-origins">Orígenes autorizados (uno por línea)</label>
            <textarea id="s-origins">${esc((app.allowed_origins || []).join('\n'))}</textarea>
            <div class="hint">Solo estos dominios podrán registrar suscriptores. Admite <code>*.midominio.com</code>.</div></div>
          <div class="field"><label for="s-icon">Icono por defecto</label>
            <input id="s-icon" type="url" value="${esc(app.default_icon_url || '')}"></div>
          <button id="save-app">Guardar</button>
        </div>

        <div class="card">
          <div class="card-head"><h2>Petición de permiso</h2></div>
          <div class="field"><label for="p-type">Tipo</label>
            <select id="p-type">
              <option value="slide"${prompt.type === 'slide' ? ' selected' : ''}>Aviso deslizante (recomendado)</option>
              <option value="native"${prompt.type === 'native' ? ' selected' : ''}>Nativo del navegador</option>
              <option value="bell"${prompt.type === 'bell' ? ' selected' : ''}>Campana flotante</option>
              <option value="manual"${prompt.type === 'manual' ? ' selected' : ''}>Manual (lo lanzas tú)</option>
            </select></div>
          <div class="row">
            <div class="field"><label for="p-delay">Retraso (segundos)</label>
              <input id="p-delay" type="number" value="${prompt.delay_seconds ?? 5}" min="0"></div>
            <div class="field"><label for="p-views">Tras N páginas vistas</label>
              <input id="p-views" type="number" value="${prompt.page_views ?? 1}" min="1"></div>
            <div class="field"><label for="p-remind">Reintentar tras (días)</label>
              <input id="p-remind" type="number" value="${prompt.remind_after_days ?? 7}" min="1"></div>
          </div>
          <div class="field"><label for="p-title">Título</label>
            <input id="p-title" value="${esc(prompt.title || '¿Quieres recibir notificaciones?')}"></div>
          <div class="field"><label for="p-message">Texto</label>
            <input id="p-message" value="${esc(prompt.message || 'Te avisaremos solo de lo importante.')}"></div>
          <div class="row">
            <div class="field"><label for="p-accept">Botón aceptar</label>
              <input id="p-accept" value="${esc(prompt.accept_text || 'Permitir')}"></div>
            <div class="field"><label for="p-cancel">Botón rechazar</label>
              <input id="p-cancel" value="${esc(prompt.cancel_text || 'Ahora no')}"></div>
          </div>
          <button id="save-prompt">Guardar</button>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-head"><h2>Entrega</h2></div>
          <div class="check"><input type="checkbox" id="q-enabled"${quiet.enabled ? ' checked' : ''}>
            <label for="q-enabled">Respetar horas silenciosas</label></div>
          <div class="row">
            <div class="field"><label for="q-start">Desde (hora local)</label>
              <input id="q-start" type="time" value="${esc(quiet.start || '22:00')}"></div>
            <div class="field"><label for="q-end">Hasta</label>
              <input id="q-end" type="time" value="${esc(quiet.end || '08:00')}"></div>
          </div>
          <div class="check"><input type="checkbox" id="c-enabled"${cap.enabled ? ' checked' : ''}>
            <label for="c-enabled">Limitar notificaciones por usuario y día</label></div>
          <div class="field"><label for="c-max">Máximo diario</label>
            <input id="c-max" type="number" value="${cap.max_per_day ?? 3}" min="1"></div>
          <button id="save-delivery">Guardar</button>
        </div>

        <div class="card">
          <div class="card-head"><h2>Notificación de bienvenida</h2></div>
          <div class="check"><input type="checkbox" id="w-enabled"${welcome.enabled ? ' checked' : ''}>
            <label for="w-enabled">Enviar al suscribirse</label></div>
          <div class="field"><label for="w-title">Título</label>
            <input id="w-title" value="${esc(welcome.title?.es || `¡Bienvenido a ${app.name}!`)}"></div>
          <div class="field"><label for="w-message">Mensaje</label>
            <input id="w-message" value="${esc(welcome.message?.es || 'Gracias por suscribirte.')}"></div>
          <button id="save-welcome">Guardar</button>
        </div>

        <div class="card">
          <div class="card-head"><h2>Claves de API</h2>
            <button class="btn-sm" id="new-key">Nueva clave</button></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Nombre</th><th>Prefijo</th><th>Último uso</th><th></th></tr></thead>
            <tbody>${keys.keys.filter((k) => !k.revoked_at).map((k) => `<tr>
              <td>${esc(k.name)}</td>
              <td class="mono small">pf_${esc(k.key_prefix)}…</td>
              <td class="small muted">${k.last_used_at ? dateTime(k.last_used_at) : 'nunca'}</td>
              <td><button class="btn-ghost btn-sm" data-revoke="${k.id}">Revocar</button></td>
            </tr>`).join('')}</tbody></table></div>
          <div class="field mt"><label>ID de la aplicación</label>
            <div class="snippet">${esc(app.id)}</div></div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Estado del sistema</h2></div>
          <table><tbody>
            <tr><td>Versión</td><td class="num">${esc(system.version)} · Node ${esc(system.node)}</td></tr>
            <tr><td>Tamaño de la base de datos</td><td class="num">${esc(system.db_size)}</td></tr>
            <tr><td>Trabajos en cola</td><td class="num">${
              system.jobs.filter((j) => j.status === 'pending').reduce((s, j) => s + j.n, 0)}</td></tr>
            <tr><td>Trabajos fallidos</td><td class="num">${
              system.jobs.filter((j) => j.status === 'failed').reduce((s, j) => s + j.n, 0)}</td></tr>
          </tbody></table>
        </div>
      </div>
    </div>`;

  const saveSettings = async (patch) => {
    const merged = { ...settings, ...patch };
    await api(`/apps/${state.app.id}`, { method: 'PATCH', body: { settings: merged } });
    toast('Ajustes guardados');
    render();
  };

  main.querySelector('#save-app').addEventListener('click', async () => {
    try {
      await api(`/apps/${state.app.id}`, { method: 'PATCH', body: {
        name: main.querySelector('#s-name').value,
        site_url: main.querySelector('#s-site').value || null,
        allowed_origins: main.querySelector('#s-origins').value.split('\n')
          .map((s) => s.trim()).filter(Boolean),
        default_icon_url: main.querySelector('#s-icon').value || null,
      } });
      toast('Guardado');
      await loadApps();
      render();
    } catch (err) { toast(err.message, true); }
  });

  main.querySelector('#save-prompt').addEventListener('click', () => saveSettings({ prompt: {
    type: main.querySelector('#p-type').value,
    delay_seconds: Number(main.querySelector('#p-delay').value),
    page_views: Number(main.querySelector('#p-views').value),
    remind_after_days: Number(main.querySelector('#p-remind').value),
    title: main.querySelector('#p-title').value,
    message: main.querySelector('#p-message').value,
    accept_text: main.querySelector('#p-accept').value,
    cancel_text: main.querySelector('#p-cancel').value,
    bell_position: prompt.bell_position || 'bottom-right',
  } }).catch((err) => toast(err.message, true)));

  main.querySelector('#save-delivery').addEventListener('click', () => saveSettings({
    quiet_hours: {
      enabled: main.querySelector('#q-enabled').checked,
      start: main.querySelector('#q-start').value,
      end: main.querySelector('#q-end').value,
    },
    frequency_cap: {
      enabled: main.querySelector('#c-enabled').checked,
      max_per_day: Number(main.querySelector('#c-max').value),
    },
  }).catch((err) => toast(err.message, true)));

  main.querySelector('#save-welcome').addEventListener('click', () => saveSettings({
    welcome_notification: {
      enabled: main.querySelector('#w-enabled').checked,
      title: { es: main.querySelector('#w-title').value },
      message: { es: main.querySelector('#w-message').value },
    },
  }).catch((err) => toast(err.message, true)));

  main.querySelector('#new-key').addEventListener('click', async () => {
    const name = prompt2('Nombre de la clave', 'integración');
    if (!name) return;
    try {
      const result = await api(`/apps/${state.app.id}/keys`, { method: 'POST', body: { name } });
      alert(`Guarda esta clave ahora, no se volverá a mostrar:\n\n${result.api_key}`);
      render();
    } catch (err) { toast(err.message, true); }
  });

  bind('[data-revoke]', 'click', async (event) => {
    if (!confirm('¿Revocar esta clave? Las integraciones que la usen dejarán de funcionar.')) return;
    await api(`/apps/${state.app.id}/keys/${event.currentTarget.dataset.revoke}`, { method: 'DELETE' });
    toast('Clave revocada'); render();
  });
};

const prompt2 = (message, value) => window.prompt(message, value);

// ---------------------------------------------------------------------------
// Sin apps todavía
// ---------------------------------------------------------------------------
function renderNoApps() {
  root.innerHTML = `
    <div class="login-wrap"><div class="card login-card" style="max-width:440px">
      <div class="brand"><span class="logo">🔔</span> PushFlow</div>
      <h2 class="mb">Crea tu primera aplicación</h2>
      <p class="small muted mb">Una «aplicación» agrupa un sitio web y/o una APK con sus
        suscriptores, notificaciones y estadísticas.</p>
      <div class="field"><label for="new-name">Nombre</label>
        <input id="new-name" placeholder="Mi tienda online" autofocus></div>
      <div class="field"><label for="new-url">URL del sitio (opcional)</label>
        <input id="new-url" type="url" placeholder="https://mitienda.com"></div>
      <button id="create-app" style="width:100%">Crear aplicación</button>
    </div></div>`;

  root.querySelector('#create-app').addEventListener('click', async () => {
    const name = root.querySelector('#new-name').value.trim();
    if (!name) return toast('Escribe un nombre', true);
    try {
      const result = await api('/apps', { method: 'POST', body: {
        name, site_url: root.querySelector('#new-url').value || null } });
      alert(`Aplicación creada.\n\nGuarda tu clave de API (no se volverá a mostrar):\n\n${result.api_key}`);
      await loadApps();
      state.app = state.apps.find((a) => a.id === result.app.id);
      go('install');
    } catch (err) { toast(err.message, true); }
  });
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
const fetchApiV1 = (path, options) => api(`/apps/${state.app.id}${path}`, options);

async function loadApps() {
  const { apps } = await api('/apps');
  state.apps = apps;
  return apps;
}

async function boot() {
  try {
    const me = await api('/me');
    state.user = me.user;
  } catch { return renderLogin(); }

  await loadApps();
  if (!state.apps.length) return renderNoApps();

  const match = /#\/app\/([0-9a-f-]+)\/(\w+)/.exec(location.hash);
  state.app = state.apps.find((a) => a.id === match?.[1]) || state.apps[0];
  state.view = match?.[2] && VIEWS[match[2]] ? match[2] : 'overview';
  render();
}

window.addEventListener('hashchange', () => {
  const match = /#\/app\/([0-9a-f-]+)\/(\w+)/.exec(location.hash);
  if (match && (match[1] !== state.app?.id || match[2] !== state.view)) boot();
});

boot();
