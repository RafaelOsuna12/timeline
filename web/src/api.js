/**
 * Cliente HTTP del tablero.
 *
 * Guarda el token de sesion en localStorage y lo adjunta a cada peticion.
 * Ante un 401 limpia la sesion y avisa para que la app vuelva al login.
 */
const TOKEN_KEY = 'estadisticas.token';
const USER_KEY = 'estadisticas.user';

let onUnauthorized = () => {};

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export const session = {
  get token() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  get user() {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  save(token, user) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {
      /* modo privado: la sesion vivira solo en memoria */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {
      /* nada que limpiar */
    }
  },
};

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, signal, raw = false } = {}) {
  const headers = {};
  const token = session.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    signal,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    session.clear();
    onUnauthorized();
    throw new ApiError('Sesion expirada. Vuelve a iniciar sesion.', 401);
  }
  if (raw) {
    if (!res.ok) throw new ApiError('No se pudo completar la descarga.', res.status);
    return res;
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!res.ok) {
    throw new ApiError(payload?.error || `Error ${res.status}`, res.status, payload?.code);
  }
  return payload;
}

/** Convierte el objeto de filtros en query string, omitiendo lo vacio. */
export function toQuery(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  login: (username, password) => request('/auth/login', { method: 'POST', body: { username, password } }),
  me: () => request('/auth/me'),

  snapshots: () => request('/snapshots'),
  filters: (q) => request(`/filters${toQuery(q)}`),
  overview: (q, signal) => request(`/overview${toQuery(q)}`, { signal }),
  hierarchy: (q, signal) => request(`/hierarchy${toQuery(q)}`, { signal }),
  promoters: (q, signal) => request(`/promoters${toQuery(q)}`, { signal }),
  promoter: (id, q, signal) => request(`/promoters/${encodeURIComponent(id)}${toQuery(q)}`, { signal }),
  models: (q, signal) => request(`/models${toQuery(q)}`, { signal }),
  stores: (q, signal) => request(`/stores${toQuery(q)}`, { signal }),
  attendance: (q, signal) => request(`/attendance${toQuery(q)}`, { signal }),
  comparison: (q, signal) => request(`/comparison${toQuery(q)}`, { signal }),

  uploadHistory: () => request('/uploads'),
  uploadJob: (id) => request(`/uploads/jobs/${id}`),
  deleteSnapshot: (id) => request(`/uploads/${id}`, { method: 'DELETE' }),

  users: () => request('/auth/users'),
  createUser: (payload) => request('/auth/users', { method: 'POST', body: payload }),
  updateUser: (id, payload) => request(`/auth/users/${id}`, { method: 'PATCH', body: payload }),
  deleteUser: (id) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  audit: () => request('/admin/audit'),
};

/** Sube el archivo con XHR para poder reportar el avance real de la carga. */
export function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    const token = session.token;
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new ApiError(payload?.error || `Error ${xhr.status}`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Fallo la conexion durante la carga.', 0));
    xhr.send(form);
  });
}

/** Descarga un CSV respetando la sesion (no se puede usar un <a> simple). */
export async function downloadCsv(dataset, params) {
  const res = await request(`/export/${dataset}.csv${toQuery(params)}`, { raw: true });
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match ? match[1] : `${dataset}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
