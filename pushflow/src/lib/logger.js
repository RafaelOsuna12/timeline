import config from '../config.js';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const threshold = LEVELS[config.logLevel] || 30;

function emit(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg, ...(extra || {}) };
  const out = level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  trace: (m, e) => emit('trace', m, e),
  debug: (m, e) => emit('debug', m, e),
  info: (m, e) => emit('info', m, e),
  warn: (m, e) => emit('warn', m, e),
  error: (m, e) => emit('error', m, e),
  fatal: (m, e) => emit('fatal', m, e),
  child: (bindings) => ({
    trace: (m, e) => emit('trace', m, { ...bindings, ...e }),
    debug: (m, e) => emit('debug', m, { ...bindings, ...e }),
    info: (m, e) => emit('info', m, { ...bindings, ...e }),
    warn: (m, e) => emit('warn', m, { ...bindings, ...e }),
    error: (m, e) => emit('error', m, { ...bindings, ...e }),
    fatal: (m, e) => emit('fatal', m, { ...bindings, ...e }),
  }),
};

export default logger;
