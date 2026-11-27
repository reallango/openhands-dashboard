# No npm dependencies: Node's built-in http, crypto and sqlite modules are enough.
FROM node:24.22.3-alpine3.24

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    PORT=3077 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# The build context may come from a checkout made with umask 077 (Bosun does that): make the app readable, not writable.
RUN chmod -R a+rX,go-w /app && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3077

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3077/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]
