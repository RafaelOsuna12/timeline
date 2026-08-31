export class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
  toJSON() {
    const body = { error: { code: this.code, message: this.message } };
    if (this.details) body.error.details = this.details;
    return body;
  }
}

export const badRequest  = (msg, details) => new AppError(400, 'invalid_request', msg, details);
export const unauthorized = (msg = 'Credenciales inválidas o ausentes') => new AppError(401, 'unauthorized', msg);
export const forbidden   = (msg = 'Sin permiso para esta operación') => new AppError(403, 'forbidden', msg);
export const notFound    = (msg = 'Recurso no encontrado') => new AppError(404, 'not_found', msg);
export const conflict    = (msg, details) => new AppError(409, 'conflict', msg, details);
export const tooMany     = (msg = 'Demasiadas peticiones') => new AppError(429, 'rate_limited', msg);
export const serverError = (msg = 'Error interno') => new AppError(500, 'internal_error', msg);

export default { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany, serverError };
