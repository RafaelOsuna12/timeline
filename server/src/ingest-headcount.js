/**
 * Persistencia del archivo de plantilla.
 *
 * Cada carga es una version completa e inmutable, igual que los snapshots de
 * ventas. Lo que se agrega aqui es la comparacion contra la carga anterior:
 * como el archivo se actualiza dos veces por semana, lo util no es solo la
 * foto sino el movimiento entre una y otra.
 *
 * La comparacion se hace por `person_key`, que es el ID HONOR cuando existe y
 * es confiable. El ID es mucho mejor llave que el nombre —que cambia con un
 * acento o un espacio— pero no es infalible: si un mismo ID aparece con dos
 * nombres distintos, esas personas se identifican por nombre y el caso queda
 * registrado como aviso para que se corrija en el origen.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, audit } from './db.js';
import { ROLES, nameKey, roleRank } from './parser/headcount.js';

export function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/* --------------------------- armado de personas --------------------------- */

/**
 * De asignaciones (tienda x rol) a personas.
 *
 * Una persona puede cubrir varias tiendas y, en principio, aparecer con mas
 * de un rol; se le asigna como rol principal el de mayor jerarquia y se
 * conservan todos.
 */
export function buildPeople(dataset) {
  const warnings = [];

  // El ID HONOR solo sirve como llave cuando la correspondencia con el nombre
  // es uno a uno en los dos sentidos. Un ID con dos nombres es un copiado que
  // no se actualizo; un nombre con dos IDs partiria a la persona en dos. En
  // cualquiera de los dos casos se identifica por nombre y queda el aviso.
  const namesById = new Map();
  const idsByName = new Map();
  const registra = (personId, key) => {
    if (!personId || !key) return;
    if (!namesById.has(personId)) namesById.set(personId, new Set());
    namesById.get(personId).add(key);
    if (!idsByName.has(key)) idsByName.set(key, new Set());
    idsByName.get(key).add(personId);
  };
  for (const a of dataset.assignments) if (!a.vacancy) registra(a.personId, a.nameKey);
  for (const p of dataset.middleManagement) if (!p.vacancy) registra(p.personId, p.nameKey);

  for (const [id, names] of namesById) {
    if (names.size > 1) {
      warnings.push(
        `El ID ${id} aparece con ${names.size} nombres distintos (${[...names].join(' / ')}); esas personas se identifican por nombre.`
      );
    }
  }
  for (const [key, ids] of idsByName) {
    if (ids.size > 1) {
      warnings.push(`${key} aparece con ${ids.size} IDs distintos (${[...ids].join(' / ')}); se identifica por nombre.`);
    }
  }

  const fiable = (personId, key) =>
    Boolean(personId) && namesById.get(personId)?.size === 1 && idsByName.get(key)?.size === 1;

  const keyOf = (personId, key) => (fiable(personId, key) ? personId : `n:${key}`);

  const people = new Map();
  const touch = (base) => {
    const key = keyOf(base.personId, base.nameKey);
    if (!people.has(key)) {
      people.set(key, {
        personKey: key,
        personId: base.personId || null,
        agencyId: base.agencyId || null,
        name: base.name,
        nameKey: base.nameKey,
        roles: new Set(),
        sources: new Set(),
        region: null,
        state: null,
        city: null,
        channel: null,
        employment: null,
        status: 'COVERED',
        position: null,
        hireDate: null,
        stores: [],
      });
    }
    return people.get(key);
  };

  for (const a of dataset.assignments) {
    if (a.vacancy || !a.nameKey) continue;
    const p = touch(a);
    p.roles.add(a.role);
    p.sources.add('FF');
    p.region ||= a.region;
    p.state ||= a.state;
    p.city ||= a.city;
    p.channel ||= a.channel;
    p.employment ||= a.employment;
    p.agencyId ||= a.agencyId;
    p.personId ||= a.personId;
    p.stores.push({ storeId: a.storeId, store: a.store, role: a.role, channel: a.channel, region: a.region });
  }

  for (const m of dataset.middleManagement) {
    if (m.vacancy || !m.nameKey) continue;
    const p = touch(m);
    if (m.role) p.roles.add(m.role);
    p.sources.add('MM');
    p.position ||= m.position;
    p.region ||= m.region;
    p.state ||= m.state;
    p.city ||= m.city;
    p.agencyId ||= m.agencyId;
    p.personId ||= m.personId;
  }

  // Fecha de ingreso: la hoja INGRESO solo trae promotores y los identifica
  // por nombre, que es lo unico que publica.
  for (const p of people.values()) {
    const hire = dataset.hireByName.get(p.nameKey);
    if (hire) p.hireDate = hire.hireDate;
  }

  return {
    people: [...people.values()].map((p) => {
      const roles = [...p.roles].sort((a, b) => roleRank(a) - roleRank(b));
      return {
        ...p,
        roles,
        role: roles[0] || 'SIN_ROL',
        source: p.sources.size > 1 ? 'AMBOS' : [...p.sources][0] || 'FF',
        storeCount: p.stores.length,
      };
    }),
    warnings,
  };
}

/* -------------------------- deteccion de cambios -------------------------- */

const CHANGE_KINDS = {
  ALTA: 'alta',
  BAJA: 'baja',
  TIENDAS: 'cambio_tienda',
  ROL: 'cambio_rol',
  DATOS: 'cambio_datos',
  VACANTE_ABIERTA: 'vacante_abierta',
  VACANTE_CUBIERTA: 'vacante_cubierta',
};

export { CHANGE_KINDS };

/**
 * Compara dos cargas y devuelve la lista de movimientos.
 * Los detalles guardan el nombre de la tienda y no su clave: el reporte se
 * lee tal cual, sin tener que resolver identificadores al mostrarlo.
 */
export function diffSnapshots(previousId, people, assignments, stores = []) {
  if (!previousId) return [];

  const storeName = new Map();
  for (const r of db.prepare('SELECT store_id, store, region, channel FROM hc_stores WHERE snapshot_id = ?').iterate(previousId)) {
    storeName.set(r.store_id, { store: r.store, region: r.region, channel: r.channel });
  }
  for (const s of stores) if (s.storeId) storeName.set(s.storeId, { store: s.store, region: s.region, channel: s.channel });
  const rotulo = (id) => storeName.get(id)?.store || id;

  const prevPeople = db
    .prepare('SELECT person_key, name, role, roles_json, region, store_count, hire_date FROM hc_people WHERE snapshot_id = ?')
    .all(previousId);
  const prevByKey = new Map(prevPeople.map((r) => [r.person_key, r]));

  const prevStores = new Map();
  for (const r of db
    .prepare('SELECT person_key, store_id, role FROM hc_assignments WHERE snapshot_id = ? AND person_key IS NOT NULL')
    .iterate(previousId)) {
    if (!prevStores.has(r.person_key)) prevStores.set(r.person_key, new Set());
    prevStores.get(r.person_key).add(`${r.role}@${r.store_id}`);
  }

  const prevVacancies = new Set(
    db
      .prepare("SELECT store_id, role FROM hc_assignments WHERE snapshot_id = ? AND status = 'VACANCY'")
      .all(previousId)
      .map((r) => `${r.role}@${r.store_id}`)
  );

  const curStores = new Map();
  const curVacancies = new Set();
  for (const a of assignments) {
    if (a.status === 'VACANCY') curVacancies.add(`${a.role}@${a.storeId}`);
    if (!a.personKey) continue;
    if (!curStores.has(a.personKey)) curStores.set(a.personKey, new Set());
    curStores.get(a.personKey).add(`${a.role}@${a.storeId}`);
  }

  const changes = [];
  const push = (kind, person, detail) =>
    changes.push({
      kind,
      personKey: person?.personKey || person?.person_key || null,
      name: person?.name || null,
      role: person?.role || null,
      region: person?.region || null,
      detail,
    });

  const curByKey = new Map(people.map((p) => [p.personKey, p]));

  for (const p of people) {
    const prev = prevByKey.get(p.personKey);
    if (!prev) {
      push(CHANGE_KINDS.ALTA, p, { tiendas: p.stores.map((s) => s.store), ingreso: p.hireDate });
      continue;
    }
    const before = prevStores.get(p.personKey) || new Set();
    const after = curStores.get(p.personKey) || new Set();
    const salio = [...before].filter((x) => !after.has(x));
    const entro = [...after].filter((x) => !before.has(x));
    if (salio.length || entro.length) {
      push(CHANGE_KINDS.TIENDAS, p, {
        dejo: salio.map((x) => rotulo(x.split('@')[1])),
        tomo: entro.map((x) => rotulo(x.split('@')[1])),
      });
    }
    const rolesAntes = safeJson(prev.roles_json, []);
    if (rolesAntes.join('|') !== p.roles.join('|')) {
      push(CHANGE_KINDS.ROL, p, { antes: rolesAntes, ahora: p.roles });
    }
    if (!prev.hire_date && p.hireDate) {
      push(CHANGE_KINDS.DATOS, p, { campo: 'fecha de ingreso', antes: null, ahora: p.hireDate });
    }
  }

  for (const prev of prevPeople) {
    if (curByKey.has(prev.person_key)) continue;
    push(CHANGE_KINDS.BAJA, { personKey: prev.person_key, name: prev.name, role: prev.role, region: prev.region }, {});
  }

  const vacante = (kind, clave) => {
    const [role, storeId] = clave.split('@');
    const info = storeName.get(storeId) || {};
    changes.push({
      kind,
      personKey: null,
      name: null,
      role,
      region: info.region || null,
      detail: { storeId, tienda: info.store || storeId, canal: info.channel || null },
    });
  };
  for (const v of curVacancies) if (!prevVacancies.has(v)) vacante(CHANGE_KINDS.VACANTE_ABIERTA, v);
  for (const v of prevVacancies) if (!curVacancies.has(v)) vacante(CHANGE_KINDS.VACANTE_CUBIERTA, v);

  return changes;
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/* ------------------------------ persistencia ------------------------------ */

/** Guarda la carga completa y devuelve su id. Todo en una transaccion. */
export function saveHeadcount(dataset, { storedFile = null, hash = null, uploadedBy = null } = {}) {
  const { people, warnings: peopleWarnings } = buildPeople(dataset);
  const byName = new Map(people.map((p) => [p.nameKey, p]));

  // Las asignaciones apuntan a la persona ya resuelta (o a nadie, si la plaza
  // esta vacante).
  const assignments = dataset.assignments.map((a) => ({
    ...a,
    personKey: a.vacancy || !a.nameKey ? null : byName.get(a.nameKey)?.personKey || null,
  }));

  const previousId = latestHeadcountId();
  const changes = diffSnapshots(previousId, people, assignments, dataset.stores);

  const insSnapshot = db.prepare(`
    INSERT INTO hc_snapshots (source_name, stored_file, file_hash, uploaded_by, created_at, status, meta_json)
    VALUES (?,?,?,?,?,?,?)
  `);
  const insStore = db.prepare(`
    INSERT INTO hc_stores (snapshot_id, store_id, store, store_key, channel, region, state, city,
                           city_coverage, locality, city_class, listing, tier, address, channel_store_id,
                           coverage_time, active)
    VALUES (@snapshot_id,@store_id,@store,@store_key,@channel,@region,@state,@city,
            @city_coverage,@locality,@city_class,@listing,@tier,@address,@channel_store_id,
            @coverage_time,@active)
  `);
  const insPerson = db.prepare(`
    INSERT INTO hc_people (snapshot_id, person_key, person_id, agency_id, name, name_key, role, roles_json,
                           source, position, region, state, city, channel, employment, status, hire_date, store_count)
    VALUES (@snapshot_id,@person_key,@person_id,@agency_id,@name,@name_key,@role,@roles_json,
            @source,@position,@region,@state,@city,@channel,@employment,@status,@hire_date,@store_count)
  `);
  const insAssign = db.prepare(`
    INSERT INTO hc_assignments (snapshot_id, seq, store_id, person_key, role, employment, status, zone, route)
    VALUES (@snapshot_id,@seq,@store_id,@person_key,@role,@employment,@status,@zone,@route)
  `);
  const insChange = db.prepare(`
    INSERT INTO hc_changes (snapshot_id, previous_id, seq, kind, person_key, name, role, region, detail_json)
    VALUES (@snapshot_id,@previous_id,@seq,@kind,@person_key,@name,@role,@region,@detail_json)
  `);

  const run = db.transaction(() => {
    const roleCounts = {};
    for (const a of assignments) {
      roleCounts[a.role] ||= { assignments: 0, vacancies: 0 };
      roleCounts[a.role].assignments += 1;
      if (a.status === 'VACANCY') roleCounts[a.role].vacancies += 1;
    }

    const info = insSnapshot.run(
      dataset.meta.sourceName || null,
      storedFile,
      hash,
      uploadedBy,
      new Date().toISOString(),
      'ready',
      JSON.stringify({
        sheetNames: dataset.meta.sheetNames || [],
        roleBlocks: dataset.meta.roleBlocks || [],
        hireStats: dataset.meta.hireStats || null,
        storeStats: dataset.meta.storeStats || null,
        warnings: [...(dataset.meta.warnings || []), ...peopleWarnings],
        parsedAt: dataset.meta.parsedAt,
        storeCount: dataset.stores.length,
        peopleCount: people.length,
        middleCount: dataset.middleManagement.filter((m) => !m.vacancy).length,
        roleCounts,
        previousId,
        changeCount: changes.length,
      })
    );
    const id = info.lastInsertRowid;

    const vistas = new Set();
    for (const s of dataset.stores) {
      if (!s.storeId || vistas.has(s.storeId)) continue;
      vistas.add(s.storeId);
      insStore.run({
        snapshot_id: id,
        store_id: s.storeId,
        store: s.store || s.storeId,
        store_key: s.storeKey || null,
        channel: s.channel || null,
        region: s.region || null,
        state: s.state || null,
        city: s.city || null,
        city_coverage: s.cityCoverage || null,
        locality: s.locality || null,
        city_class: s.cityClass || null,
        listing: s.listing || null,
        tier: s.tier || null,
        address: s.address || null,
        channel_store_id: s.channelStoreId || null,
        coverage_time: s.coverageTime || null,
        active: s.active ? 1 : 0,
      });
    }

    for (const p of people) {
      insPerson.run({
        snapshot_id: id,
        person_key: p.personKey,
        person_id: p.personId,
        agency_id: p.agencyId,
        name: p.name,
        name_key: p.nameKey,
        role: p.role,
        roles_json: JSON.stringify(p.roles),
        source: p.source,
        position: p.position,
        region: p.region,
        state: p.state,
        city: p.city,
        channel: p.channel,
        employment: p.employment,
        status: p.status,
        hire_date: p.hireDate,
        store_count: p.storeCount,
      });
    }

    assignments.forEach((a, seq) =>
      insAssign.run({
        snapshot_id: id,
        seq,
        store_id: a.storeId,
        person_key: a.personKey,
        role: a.role,
        employment: a.employment,
        status: a.status,
        zone: a.zone,
        route: a.route,
      })
    );

    changes.forEach((c, seq) =>
      insChange.run({
        snapshot_id: id,
        previous_id: previousId,
        seq,
        kind: c.kind,
        person_key: c.personKey,
        name: c.name,
        role: c.role,
        region: c.region,
        detail_json: JSON.stringify(c.detail || {}),
      })
    );

    return id;
  });

  const id = run();
  audit(uploadedBy, 'hc_upload', { id, source: dataset.meta.sourceName, people: people.length, changes: changes.length });
  return { id, people: people.length, stores: dataset.stores.length, changes: changes.length, previousId };
}

/** Ultima carga de plantilla, o null si no hay ninguna. */
export function latestHeadcountId() {
  const row = db.prepare("SELECT id FROM hc_snapshots WHERE status = 'ready' ORDER BY created_at DESC, id DESC LIMIT 1").get();
  return row ? row.id : null;
}

export const ROLE_LIST = ROLES;
export { nameKey };
