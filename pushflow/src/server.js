#!/usr/bin/env node
/**
 * Servidor HTTP de PushFlow.
 *
 *   /api/v1/*      API REST autenticada con clave de API
 *   /sdk/v1/*      endpoints públicos que consumen los SDK
 *   /admin/api/*   panel de administración (sesión por cookie)
 *   /              interfaz del panel y ficheros estáticos
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import config from './config.js';
import { healthcheck, pool } from './db/index.js';
import { AppError } from './lib/errors.js';
import logger from './lib/logger.js';
import { requireApiKey } from './plugins/auth.js';

import notificationRoutes from './routes/api/notifications.js';
import subscriptionRoutes from './routes/api/subscriptions.js';
import segmentRoutes from './routes/api/segments.js';
import analyticsRoutes from './routes/api/analytics.js';
import automationRoutes from './routes/api/automations.js';
import publicRoutes from './routes/public/index.js';
import dashboardRoutes from './routes/dashboard/index.js';

const PUBLIC_DIR = resolve(config.rootDir, 'public');

export async function buildServer() {
  const fastify = Fastify({
    logger: false,
    trustProxy: config.server.trustProxy,
    bodyLimit: config.server.bodyLimit,
    // Sin logger de Fastify: el registro de peticiones lo hace nuestro hook onResponse.
    routerOptions: { ignoreTrailingSlash: true },
    genReqId: () => Math.random().toString(36).slice(2, 12),
  });

  // --- Plugins base ---------------------------------------------------------
  await fastify.register(cors, {
    origin: config.security.corsOrigins.includes('*') ? true : config.security.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-api-key'],
  });
  await fastify.register(cookie, { secret: config.security.appSecret });
  await fastify.register(formbody);

  // --- Registro y errores ---------------------------------------------------
  fastify.addHook('onResponse', (request, reply, done) => {
    if (reply.statusCode >= 400 || request.url.startsWith('/api/')) {
      logger.debug('petición', {
        method: request.method, url: request.url, status: reply.statusCode,
        ms: Math.round(reply.elapsedTime), ip: request.ip,
      });
    }
    done();
  });

  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(error.toJSON());
    }
    if (error.statusCode === 429) {
      return reply.code(429).send({
        error: { code: 'rate_limited', message: 'Demasiadas peticiones, inténtalo más tarde' } });
    }
    if (error.validation || error.statusCode === 400) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: error.message } });
    }
    // Errores propios de Fastify que ya traen su estado (413 cuerpo demasiado
    // grande, 415 tipo no soportado, 405 método no permitido…). Sin esto se
    // convertían en un 500 y se registraban como fallo del servidor.
    if (error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: { code: error.code || 'request_error', message: error.message } });
    }
    // 22P02 = invalid_text_representation: un uuid o número mal formado en la
    // petición. Es un error del cliente, no del servidor.
    if (error.code === '22P02') {
      return reply.code(400).send({
        error: { code: 'invalid_request',
                 message: 'Algún identificador de la petición tiene un formato inválido' } });
    }
    logger.error('error no controlado', {
      url: request.url, method: request.method, error: error.message, stack: error.stack });
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Error interno del servidor', request_id: request.id } });
  });

  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/admin/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Endpoint no encontrado' } });
    }
    // El panel es una SPA: cualquier otra ruta devuelve el index.
    return reply.type('text/html').send(readFileSync(resolve(PUBLIC_DIR, 'dashboard/index.html')));
  });

  // --- Salud ----------------------------------------------------------------
  fastify.get('/health', async (request, reply) => {
    try {
      const db = await healthcheck();
      return { status: 'ok', db, uptime_sec: Math.floor(process.uptime()), version: '1.0.0' };
    } catch (err) {
      reply.code(503);
      return { status: 'degraded', error: err.message };
    }
  });

  // --- API REST (clave de API) ---------------------------------------------
  await fastify.register(async (api) => {
    // El plugin se registra dentro del ámbito para que aplique a todas sus rutas:
    // con `global: false` no se activaría ninguna.
    await api.register(rateLimit, {
      max: config.security.apiRateLimit,
      timeWindow: '1 minute',
      // Se cuenta por clave de API; si falta, por IP.
      keyGenerator: (request) =>
        request.headers['x-api-key'] || request.headers.authorization || request.ip,
    });
    api.addHook('preHandler', requireApiKey);
    await api.register(notificationRoutes);
    await api.register(subscriptionRoutes);
    await api.register(segmentRoutes);
    await api.register(analyticsRoutes);
    await api.register(automationRoutes);
  }, { prefix: '/api/v1' });

  // --- Endpoints públicos del SDK ------------------------------------------
  await fastify.register(async (pub) => {
    await pub.register(rateLimit, {
      max: config.security.publicRateLimit,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.ip,
    });
    await pub.register(publicRoutes);
  });

  // --- Panel ----------------------------------------------------------------
  await fastify.register(async (admin) => {
    await admin.register(rateLimit, {
      max: 300,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.ip,
    });
    await admin.register(dashboardRoutes);
  });

  // --- Estáticos ------------------------------------------------------------
  await fastify.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: false,
    cacheControl: true,
    maxAge: '1h',
    setHeaders: (res, path) => {
      // El service worker no debe cachearse de forma agresiva.
      if (path.endsWith('pushflow-sw.js')) res.setHeader('cache-control', 'no-cache');
      if (path.includes('/sdk/')) res.setHeader('cache-control', 'public, max-age=3600');
    },
  });

  /**
   * Service worker servido desde la raíz del propio dominio de PushFlow.
   * En el sitio del cliente debe copiarse a su raíz (ver documentación).
   */
  fastify.get('/pushflow-sw.js', async (request, reply) => {
    reply.type('application/javascript; charset=utf-8');
    reply.header('cache-control', 'no-cache');
    reply.header('service-worker-allowed', '/');
    return readFileSync(resolve(PUBLIC_DIR, 'sdk/v1/pushflow-sw.js'), 'utf8');
  });

  fastify.get('/', async (request, reply) => {
    reply.type('text/html');
    return readFileSync(resolve(PUBLIC_DIR, 'dashboard/index.html'), 'utf8');
  });

  return fastify;
}

// --- Arranque ---------------------------------------------------------------
const isMain = process.argv[1]?.endsWith('server.js');
if (isMain) {
  const fastify = await buildServer();

  // Modo todo-en-uno para VPS pequeños: worker dentro del proceso del servidor.
  let worker = null;
  if (config.worker.inline) {
    const { startWorker } = await import('./workers/index.js');
    worker = await startWorker();
    logger.info('worker embebido activo (WORKER_INLINE=true)');
  }

  try {
    await fastify.listen({ host: config.server.host, port: config.server.port });
    logger.info('PushFlow escuchando', {
      url: config.server.publicUrl, port: config.server.port, env: config.env });
  } catch (err) {
    logger.fatal('no se pudo iniciar el servidor', { error: err.message });
    process.exit(1);
  }

  const shutdown = async (signal) => {
    logger.info('apagando servidor', { signal });
    await fastify.close();
    if (worker) await worker.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('promesa rechazada sin gestionar', { reason: String(reason) });
  });
}
