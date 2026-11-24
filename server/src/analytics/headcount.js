/**
 * Vistas de la plantilla.
 *
 * La carga completa son ~1,100 tiendas y ~190 personas: cabe de sobra en
 * memoria, asi que se carga entera y los cortes se calculan al vuelo, igual
 * que con los snapshots de ventas. Asi cualquier filtro —region, canal,
 * estado, ciudad, rol— sale de los mismos datos y no puede desincronizarse.
 */
import { db } from '../db.js';
import { ROLES, roleLabel, roleRank } from '../parser/headcount.js';

const CACHE_LIMIT = 3;
const cache = new Map();

export function invalidateHeadcountCache(id) {
  if (id === undefined) cache.clear();
  else cache.delete(Number(id));
}

const safeJson = (t, f) => {
  try {
    return JSON.parse(t);
  } catch {
    return f;
  }
};

/** Metadatos de todas las cargas, la mas reciente primero. */
export function listHeadcountSnapshots() {
  return db
    .prepare("SELECT id, source_name, uploaded_by, created_at, status, meta_json FROM hc_snapshots WHERE status = 'ready' ORDER BY created_at DESC, id DESC")
    .all()
    .map((r) => {
      const meta = safeJson(r.meta_json, {});
      return {
        id: r.id,
        sourceName: r.source_name,
        uploadedBy: r.uploaded_by,
        createdAt: r.created_at,
        peopleCount: meta.peopleCount ?? null,
        storeCount: meta.storeCount ?? null,
        changeCount: meta.changeCount ?? null,
        previousId: meta.previousId ?? null,
        warnings: meta.warnings || [],
      };
    });
}

export function currentHeadcountId() {
  const row = db.prepare("SELECT id FROM hc_snapshots WHERE status = 'ready' ORDER BY created_at DESC, id DESC LIMIT 1").get();
  return row ? row.id : null;
}

/** Carga completa en memoria. */
export function loadHeadcount(snapshotId) {
  const id = Number(snapshotId);
  if (cache.has(id)) return cache.get(id);

  const row = db.prepare('SELECT * FROM hc_snapshots WHERE id = ?').get(id);
  if (!row) return null;
  const meta = safeJson(row.meta_json, {});

  const stores = db.prepare('SELECT * FROM hc_stores WHERE snapshot_id = ?').all(id).map((s) => ({
    storeId: s.store_id,
    store: s.store,
    channel: s.channel,
    region: s.region,
    state: s.state,
    city: s.city,
    cityCoverage: s.city_coverage,
    locality: s.locality,
    cityClass: s.city_class,
    listing: s.listing,
    channelStoreId: s.channel_store_id,
    coverageTime: s.coverage_time,
    // Una tienda esta activa cuando tiene plaza de promotor, con titular o
    // vacante. Las demas siguen en el universo del archivo pero no cuentan
    // como tienda asignada para el supervisor mix ni para el city manager.
    active: s.active !== 0,
    staff: [],
  }));
  const storeById = new Map(stores.map((s) => [s.storeId, s]));

  const people = db.prepare('SELECT * FROM hc_people WHERE snapshot_id = ?').all(id).map((p) => ({
    key: p.person_key,
    personId: p.person_id,
    agencyId: p.agency_id,
    name: p.name,
    nameKey: p.name_key,
    role: p.role,
    roles: safeJson(p.roles_json, [p.role]),
    source: p.source,
    position: p.position,
    region: p.region,
    state: p.state,
    city: p.city,
    channel: p.channel,
    employment: p.employment,
    status: p.status,
    hireDate: p.hire_date,
    storeCount: p.store_count,
    stores: [],
  }));
  const peopleByKey = new Map(people.map((p) => [p.key, p]));

  const assignments = [];
  for (const a of db.prepare('SELECT * FROM hc_assignments WHERE snapshot_id = ? ORDER BY seq').iterate(id)) {
    const store = storeById.get(a.store_id) || null;
    const person = a.person_key ? peopleByKey.get(a.person_key) || null : null;
    const record = {
      storeId: a.store_id,
      store: store?.store || a.store_id,
      channel: store?.channel || null,
      region: store?.region || null,
      state: store?.state || null,
      city: store?.city || null,
      personKey: a.person_key,
      name: person?.name || null,
      personId: person?.personId || null,
      role: a.role,
      employment: a.employment,
      status: a.status,
      zone: a.zone,
      route: a.route,
      vacancy: a.status === 'VACANCY',
    };
    assignments.push(record);
    if (store) store.staff.push(record);
    if (person) person.stores.push(record);
  }

  const changes = db.prepare('SELECT * FROM hc_changes WHERE snapshot_id = ? ORDER BY seq').all(id).map((c) => ({
    kind: c.kind,
    personKey: c.person_key,
    name: c.name,
    role: c.role,
    region: c.region,
    detail: safeJson(c.detail_json, {}),
  }));

  const snapshot = {
    meta: {
      id: row.id,
      sourceName: row.source_name,
      uploadedBy: row.uploaded_by,
      createdAt: row.created_at,
      previousId: meta.previousId ?? null,
      warnings: meta.warnings || [],
      hireStats: meta.hireStats || null,
      roleCounts: meta.roleCounts || {},
    },
    stores,
    people,
    assignments,
    changes,
  };
  cache.set(id, snapshot);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return snapshot;
}

/* -------------------------------- filtros -------------------------------- */

const norm = (v) => (v === null || v === undefined ? '' : String(v).trim().toUpperCase());

/**
 * Filtra personas. La region es el filtro principal —es el corte con el que
 * se consulta a diario— y el resto acota dentro de ella.
 */
export function filterPeople(people, filters = {}) {
  const want = {
    region: norm(filters.region),
    role: norm(filters.role),
    channel: norm(filters.channel),
    state: norm(filters.state),
    city: norm(filters.city),
    status: norm(filters.status),
    source: norm(filters.source),
    search: norm(filters.search),
  };
  return people.filter((p) => {
    if (want.region && norm(p.region) !== want.region) return false;
    if (want.role && !p.roles.some((r) => norm(r) === want.role)) return false;
    if (want.state && norm(p.state) !== want.state) return false;
    if (want.city && norm(p.city) !== want.city) return false;
    if (want.status && norm(p.status) !== want.status) return false;
    if (want.source && norm(p.source) !== want.source) return false;
    if (want.channel && !p.stores.some((s) => norm(s.channel) === want.channel) && norm(p.channel) !== want.channel) {
      return false;
    }
    if (want.search) {
      const hay = `${p.name} ${p.personId || ''} ${p.agencyId || ''} ${p.city || ''} ${p.stores
        .map((s) => s.store)
        .join(' ')}`.toUpperCase();
      if (!hay.includes(want.search)) return false;
    }
    return true;
  });
}

/** Antiguedad en meses a partir de la fecha de ingreso. */
export function tenureMonths(hireDate, today = new Date()) {
  if (!hireDate) return null;
  const d = new Date(`${hireDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const months = (today.getUTCFullYear() - d.getUTCFullYear()) * 12 + (today.getUTCMonth() - d.getUTCMonth());
  const adj = today.getUTCDate() < d.getUTCDate() ? months - 1 : months;
  return Math.max(0, adj);
}

const presentable = (p) => ({
  key: p.key,
  name: p.name,
  personId: p.personId,
  agencyId: p.agencyId,
  role: p.role,
  roleLabel: roleLabel(p.role) === p.role ? p.position || p.role : roleLabel(p.role),
  roles: p.roles,
  position: p.position,
  source: p.source,
  region: p.region,
  state: p.state,
  city: p.city,
  channel: p.channel,
  employment: p.employment,
  status: p.status,
  hireDate: p.hireDate,
  tenureMonths: tenureMonths(p.hireDate),
  storeCount: p.storeCount,
  stores: p.stores.map((s) => s.store),
  channels: [...new Set(p.stores.map((s) => s.channel).filter(Boolean))],
});

/* -------------------------------- vistas -------------------------------- */

/** Directorio: una fila por persona, con los totales del corte elegido. */
export function buildDirectory(snapshot, filters = {}) {
  const rows = filterPeople(snapshot.people, filters);
  const list = rows.map(presentable).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es'));

  const tenures = list.map((p) => p.tenureMonths).filter((v) => v !== null).sort((a, b) => a - b);
  const vacancies = snapshot.assignments.filter(
    (a) => a.vacancy && (!filters.region || norm(a.region) === norm(filters.region)) && (!filters.role || norm(a.role) === norm(filters.role))
  );

  const byRole = new Map();
  for (const p of list) {
    if (!byRole.has(p.role)) byRole.set(p.role, { role: p.role, label: p.roleLabel, people: 0, stores: 0 });
    const e = byRole.get(p.role);
    e.people += 1;
    e.stores += p.storeCount;
  }
  for (const v of vacancies) {
    if (!byRole.has(v.role)) byRole.set(v.role, { role: v.role, label: roleLabel(v.role), people: 0, stores: 0 });
    byRole.get(v.role).vacancies = (byRole.get(v.role).vacancies || 0) + 1;
  }

  const byRegion = new Map();
  for (const p of list) {
    const k = p.region || 'SIN REGION';
    if (!byRegion.has(k)) byRegion.set(k, { region: k, people: 0, vacancies: 0 });
    byRegion.get(k).people += 1;
  }
  for (const v of vacancies) {
    const k = v.region || 'SIN REGION';
    if (!byRegion.has(k)) byRegion.set(k, { region: k, people: 0, vacancies: 0 });
    byRegion.get(k).vacancies += 1;
  }

  const hoy = new Date();
  const esteMes = list.filter(
    (p) => p.hireDate && p.hireDate.slice(0, 7) === `${hoy.getUTCFullYear()}-${String(hoy.getUTCMonth() + 1).padStart(2, '0')}`
  );

  return {
    meta: snapshot.meta,
    filters,
    people: list,
    totals: {
      people: list.length,
      stores: new Set(rows.flatMap((p) => p.stores.map((s) => s.storeId))).size,
      vacancies: vacancies.length,
      withHireDate: list.filter((p) => p.hireDate).length,
      withoutHireDate: list.filter((p) => !p.hireDate).length,
      medianTenure: tenures.length ? tenures[Math.floor(tenures.length / 2)] : null,
      newThisMonth: esteMes.length,
      coverage: list.length + vacancies.length ? list.length / (list.length + vacancies.length) : null,
    },
    byRole: [...byRole.values()].sort((a, b) => roleRank(a.role) - roleRank(b.role)),
    byRegion: [...byRegion.values()].sort((a, b) => a.region.localeCompare(b.region, 'es')),
    vacancies: vacancies.map((v) => ({
      storeId: v.storeId,
      store: v.store,
      channel: v.channel,
      region: v.region,
      city: v.city,
      role: v.role,
      roleLabel: roleLabel(v.role),
    })),
  };
}

/** Ficha de una persona: sus tiendas y su cadena de mando. */
export function buildPersonDetail(snapshot, personKey) {
  const person = snapshot.people.find((p) => p.key === personKey);
  if (!person) return null;

  const storeIds = new Set(person.stores.map((s) => s.storeId));
  const stores = snapshot.stores
    .filter((s) => storeIds.has(s.storeId))
    .map((s) => ({
      storeId: s.storeId,
      store: s.store,
      channel: s.channel,
      region: s.region,
      state: s.state,
      city: s.city,
      active: s.active,
      role: person.stores.find((x) => x.storeId === s.storeId)?.role || null,
      employment: person.stores.find((x) => x.storeId === s.storeId)?.employment || null,
      // Quien mas atiende esa tienda, sin repetir a la persona de la ficha.
      team: s.staff
        .filter((a) => a.personKey && a.personKey !== personKey)
        .map((a) => ({ name: a.name, role: a.role, roleLabel: roleLabel(a.role), personKey: a.personKey }))
        .sort((a, b) => roleRank(a.role) - roleRank(b.role)),
    }));

  // Cadena de mando: los mandos que cubren sus tiendas, sin repetir.
  const chain = new Map();
  for (const s of stores) {
    for (const t of s.team) {
      if (!ROLES.find((r) => r.key === t.role && r.group === 'mando')) continue;
      if (!chain.has(t.personKey)) chain.set(t.personKey, { ...t, stores: [] });
      chain.get(t.personKey).stores.push(s.store);
    }
  }

  return {
    meta: snapshot.meta,
    person: presentable(person),
    stores,
    chain: [...chain.values()].sort((a, b) => roleRank(a.role) - roleRank(b.role)),
  };
}

/** Tiendas con su plantilla completa. */
export function buildStoreRoster(snapshot, filters = {}) {
  const want = {
    region: norm(filters.region),
    channel: norm(filters.channel),
    state: norm(filters.state),
    city: norm(filters.city),
    search: norm(filters.search),
  };
  const soloActivas = filters.onlyActive === true || norm(filters.onlyActive) === 'TRUE' || filters.onlyActive === '1';
  const rows = snapshot.stores.filter((s) => {
    if (soloActivas && !s.active) return false;
    if (want.region && norm(s.region) !== want.region) return false;
    if (want.channel && norm(s.channel) !== want.channel) return false;
    if (want.state && norm(s.state) !== want.state) return false;
    if (want.city && norm(s.city) !== want.city) return false;
    if (want.search) {
      const hay = `${s.store} ${s.storeId} ${s.city || ''} ${s.staff.map((a) => a.name || '').join(' ')}`.toUpperCase();
      if (!hay.includes(want.search)) return false;
    }
    return true;
  });

  return {
    meta: snapshot.meta,
    stores: rows
      .map((s) => ({
        storeId: s.storeId,
        store: s.store,
        channel: s.channel,
        region: s.region,
        state: s.state,
        city: s.city,
        listing: s.listing,
        active: s.active,
        staffed: s.staff.filter((a) => !a.vacancy).length,
        vacancies: s.staff.filter((a) => a.vacancy).length,
        staff: s.staff.map((a) => ({
          name: a.name,
          personKey: a.personKey,
          role: a.role,
          roleLabel: roleLabel(a.role),
          employment: a.employment,
          vacancy: a.vacancy,
        })),
      }))
      .sort((a, b) => a.store.localeCompare(b.store, 'es')),
    totals: {
      stores: rows.length,
      active: rows.filter((s) => s.active).length,
      withStaff: rows.filter((s) => s.staff.some((a) => !a.vacancy)).length,
      withVacancy: rows.filter((s) => s.staff.some((a) => a.vacancy)).length,
      empty: rows.filter((s) => !s.staff.length).length,
    },
    onlyActive: soloActivas,
  };
}

/** Movimientos detectados contra la carga anterior. */
export function buildChanges(snapshot, filters = {}) {
  const region = norm(filters.region);
  const rows = snapshot.changes
    .filter((c) => !region || norm(c.region) === region)
    .map((c) => ({ ...c, roleLabel: c.role ? roleLabel(c.role) : null }));
  const byKind = {};
  for (const c of rows) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
  return { meta: snapshot.meta, changes: rows, byKind, total: rows.length };
}

/** Valores disponibles para los filtros. */
export function buildHeadcountFilters(snapshot) {
  const uniq = (fn, src) => [...new Set(src.map(fn).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'es'));
  const roles = [...new Set(snapshot.people.flatMap((p) => p.roles))].sort((a, b) => roleRank(a) - roleRank(b));
  // Los puestos que no son de campo (coordinadores, BI) no tienen etiqueta
  // propia: se usa el texto del puesto tal como viene en la hoja MM.
  const posicion = new Map();
  for (const p of snapshot.people) if (p.position) for (const r of p.roles) posicion.set(r, p.position);
  const etiqueta = (r) => (roleLabel(r) === r ? posicion.get(r) || r : roleLabel(r));
  return {
    regions: uniq((s) => s.region, snapshot.stores),
    channels: uniq((s) => s.channel, snapshot.stores),
    states: uniq((s) => s.state, snapshot.stores),
    cities: uniq((s) => s.city, snapshot.stores),
    roles: roles.map((r) => ({ key: r, label: etiqueta(r) })),
    relations: snapshot.stores.map((s) => ({ region: s.region, state: s.state, city: s.city, channel: s.channel })),
  };
}
