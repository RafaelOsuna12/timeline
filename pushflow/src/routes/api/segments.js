/** API de segmentos, plantillas y outcomes. */
import { one, many, query } from '../../db/index.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { requireScope } from '../../plugins/auth.js';
import { countSegment, buildFilterSql } from '../../services/audience.js';
import { Params } from '../../db/index.js';

/** Valida los filtros compilándolos a SQL antes de guardarlos. */
function assertValidFilters(filters) {
  if (!Array.isArray(filters)) throw badRequest('`filters` debe ser un array');
  buildFilterSql(filters, new Params());   // lanza si algún filtro es inválido
  return filters;
}

export default async function segmentRoutes(fastify) {
  const write = { preHandler: requireScope('subscriptions:write') };
  const read = { preHandler: requireScope('analytics:read') };

  // --- Segmentos ------------------------------------------------------------
  fastify.get('/segments', read, async (request) => ({
    segments: await many(
      `SELECT id, name, description, filters, is_system, cached_count, cached_at, created_at
       FROM segments WHERE app_id = $1 ORDER BY created_at`, [request.pushApp.id]),
  }));

  fastify.post('/segments', write, async (request, reply) => {
    const { name, description, filters } = request.body || {};
    if (!name) throw badRequest('`name` es obligatorio');
    assertValidFilters(filters || []);
    const segment = await one(
      `INSERT INTO segments (app_id, name, description, filters) VALUES ($1,$2,$3,$4)
       ON CONFLICT (app_id, lower(name)) DO UPDATE
         SET filters = EXCLUDED.filters, description = EXCLUDED.description, updated_at = now()
       RETURNING *`,
      [request.pushApp.id, name, description || null, JSON.stringify(filters || [])]);
    segment.count = await countSegment(request.pushApp.id, segment.id);
    reply.code(201);
    return { segment };
  });

  fastify.get('/segments/:id', read, async (request) => {
    const segment = await one('SELECT * FROM segments WHERE app_id = $1 AND id = $2',
      [request.pushApp.id, request.params.id]);
    if (!segment) throw notFound('Segmento no encontrado');
    return { segment, count: await countSegment(request.pushApp.id, segment.id) };
  });

  fastify.patch('/segments/:id', write, async (request) => {
    const { name, description, filters } = request.body || {};
    if (filters) assertValidFilters(filters);
    const segment = await one(
      `UPDATE segments SET name = COALESCE($3, name), description = COALESCE($4, description),
                           filters = COALESCE($5, filters), updated_at = now()
       WHERE app_id = $1 AND id = $2 RETURNING *`,
      [request.pushApp.id, request.params.id, name || null, description || null,
       filters ? JSON.stringify(filters) : null]);
    if (!segment) throw notFound('Segmento no encontrado');
    return { segment };
  });

  fastify.delete('/segments/:id', write, async (request) => {
    const { rowCount } = await query(
      `DELETE FROM segments WHERE app_id = $1 AND id = $2 AND NOT is_system`,
      [request.pushApp.id, request.params.id]);
    if (!rowCount) throw notFound('Segmento no encontrado o es del sistema');
    return { deleted: true };
  });

  /** Vista previa: cuántos dispositivos y una muestra. */
  fastify.post('/segments/preview', read, async (request) => {
    const filters = assertValidFilters(request.body?.filters || []);
    const { buildAudienceQuery } = await import('../../services/audience.js');
    const audience = await buildAudienceQuery(request.pushApp.id,
      { targetType: 'filters', filters }, { columns: 'count(*) AS n' });
    const count = Number((await one(audience.sql, audience.values))?.n) || 0;
    const sample = await buildAudienceQuery(request.pushApp.id, { targetType: 'filters', filters },
      { columns: 's.id, s.channel, s.country, s.language, s.tags, s.last_seen_at' });
    return {
      count,
      sample: await many(`${sample.sql} ORDER BY s.last_seen_at DESC LIMIT 10`, sample.values),
    };
  });

  // --- Plantillas -----------------------------------------------------------
  fastify.get('/templates', read, async (request) => ({
    templates: await many('SELECT * FROM templates WHERE app_id = $1 ORDER BY name',
      [request.pushApp.id]),
  }));

  fastify.post('/templates', write, async (request, reply) => {
    const { name, ...payload } = request.body || {};
    if (!name) throw badRequest('`name` es obligatorio');
    const template = await one(
      `INSERT INTO templates (app_id, name, payload) VALUES ($1,$2,$3)
       ON CONFLICT (app_id, lower(name)) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
       RETURNING *`,
      [request.pushApp.id, name, payload.payload || payload]);
    reply.code(201);
    return { template };
  });

  fastify.delete('/templates/:id', write, async (request) => {
    const { rowCount } = await query('DELETE FROM templates WHERE app_id = $1 AND id = $2',
      [request.pushApp.id, request.params.id]);
    if (!rowCount) throw notFound('Plantilla no encontrada');
    return { deleted: true };
  });

  // --- Outcomes (definición de conversiones) --------------------------------
  fastify.get('/outcomes', read, async (request) => ({
    outcomes: await many('SELECT * FROM outcomes WHERE app_id = $1 ORDER BY name', [request.pushApp.id]),
  }));

  fastify.post('/outcomes', write, async (request, reply) => {
    const { name, kind = 'count', attribution_window_min = 1440 } = request.body || {};
    if (!name) throw badRequest('`name` es obligatorio');
    const outcome = await one(
      `INSERT INTO outcomes (app_id, name, kind, attribution_window_min) VALUES ($1,$2,$3,$4)
       ON CONFLICT (app_id, lower(name)) DO UPDATE
         SET kind = EXCLUDED.kind, attribution_window_min = EXCLUDED.attribution_window_min
       RETURNING *`,
      [request.pushApp.id, name, kind, Number(attribution_window_min)]);
    reply.code(201);
    return { outcome };
  });
}
