# Dot for Coolify (or any Docker host). One container runs the API and serves the built board.
FROM node:24-bookworm-slim

# git for worktrees and clones, gosu to drop root after fixing volume ownership.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates gosu \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && mkdir -p /data \
 && usermod -d /data/home node

WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build -w @dot/web

COPY docker/entrypoint.sh /usr/local/bin/dot-entrypoint
RUN chmod +x /usr/local/bin/dot-entrypoint

# /data holds everything that must survive a redeploy: the database, clones, worktrees,
# chat images, and the Claude login (HOME is /data/home).
ENV NODE_ENV=production \
    HOME=/data/home \
    DOT_DATA_DIR=/data/dot \
    DOT_HOST=0.0.0.0 \
    DOT_PORT=4317 \
    DOT_GIT_USE_TOKEN=true
VOLUME /data
EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["dot-entrypoint"]
CMD ["npm", "run", "start", "-w", "@dot/server"]
