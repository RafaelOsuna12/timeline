# Imagen de PushFlow (servidor y worker comparten la misma imagen).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
RUN apk add --no-cache tini curl && addgroup -S pushflow && adduser -S -G pushflow pushflow
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data/exports && chown -R pushflow:pushflow /app
USER pushflow

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
