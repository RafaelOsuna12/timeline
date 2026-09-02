/**
 * Servidor de estadisticas.honorlab.dev
 *
 * Sirve la API REST y, en produccion, tambien el frontend compilado. El TLS lo
 * termina nginx (ver deploy/nginx), por lo que este proceso escucha solo en
 * 127.0.0.1 y confia en las cabeceras X-Forwarded-* del proxy.
 */
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { bootstrapAdmin } from './auth.js';
import { api } from './routes/api.js';
import { uploads } from './routes/uploads.js';
import { authRoutes } from './routes/auth.js';
import { currentSnapshotId } from './analytics/snapshot.js';

const app = express();

if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // El bundle de Vite inyecta estilos en linea; los scripts siguen
        // restringidos al propio origen.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // Se fija DENY para que coincida con la cabecera que añade nginx y no
    // queden dos valores distintos en la misma respuesta.
    frameguard: { action: 'deny' },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  })
);
app.use(compression());
app.use(express.json({ limit: '1mb' }));

if (config.corsOrigins.length) {
  app.use(cors({ origin: config.corsOrigins, credentials: false }));
}

// Limite general de la API (la carga de archivos tiene su propio flujo).
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Demasiadas peticiones. Espera un momento.' },
  })
);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'estadisticas-honorlab',
    time: new Date().toISOString(),
    hasData: currentSnapshotId() !== null,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/uploads', uploads);
app.use('/api', api);

app.use('/api', (req, res) => res.status(404).json({ error: 'Recurso no encontrado.' }));

/* ------------------------- frontend compilado ------------------------- */

if (fs.existsSync(config.webDist)) {
  app.use(
    express.static(config.webDist, {
      maxAge: '1h',
      setHeaders(res, filePath) {
        // Los assets llevan hash en el nombre: se pueden cachear indefinidamente.
        if (/\/assets\//.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );
  app.get('*', (req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res
      .status(503)
      .type('text/plain')
      .send('El frontend no esta compilado. Ejecuta: cd web && npm install && npm run build')
  );
}

/* --------------------------- manejo de errores --------------------------- */

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  const status = err.status || 500;
  res.status(status).json({
    error: config.isProduction && status === 500 ? 'Error interno del servidor.' : err.message,
  });
});

bootstrapAdmin();

const server = app.listen(config.port, config.host, () => {
  console.log(`[server] escuchando en http://${config.host}:${config.port}`);
  console.log(`[server] entorno: ${config.isProduction ? 'produccion' : 'desarrollo'}`);
  console.log(`[server] datos en: ${config.dataDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[server] ${signal} recibido, cerrando...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}

export default app;
