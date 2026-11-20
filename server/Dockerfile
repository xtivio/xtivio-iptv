# ---- Stage 1: install production dependencies ----
# Kept separate so the final image carries only the resolved node_modules, not
# npm itself or any install-time cache/cruft.
FROM node:24-alpine AS deps

WORKDIR /app

# Only the manifest + lockfile, for deterministic installs and good layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- Stage 2: runtime ----
FROM node:24-alpine

# Run as non-root for safety.
#
# NOTE the uid/gid are DELIBERATELY unchanged at 10001 — only the names move from
# nebula -> xtivio. Volume ownership on the host is recorded by NUMERIC uid/gid, not
# by name, so existing /data volumes stay accessible to the container without a
# chown. Changing the numbers would be the breaking move, not changing the names.
RUN addgroup -g 10001 -S xtivio && adduser -u 10001 -S xtivio -G xtivio

WORKDIR /app

# Copy the already-resolved dependencies from the deps stage (no npm in this image).
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY package.json ./
COPY server.js ./
COPY page-csp.js ./

# Drop privileges
USER xtivio

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9595

EXPOSE 9595

# Lightweight healthcheck against the /healthz endpoint (wget ships in busybox).
# Uses $PORT (sh -c so the env var expands at runtime) so it always targets the
# port the app actually listens on — no more hardcoded port to change by hand when
# PORT is overridden (e.g. 9595 in deployment).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD sh -c 'wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1'

CMD ["node", "server.js"]
