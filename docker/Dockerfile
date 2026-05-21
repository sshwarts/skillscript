# skillscript-runtime + dashboard. Single image that ships the runtime
# library, the CLI, and the dashboard SPA. The container's default CMD
# starts the dashboard (which spins up the runtime in-process).
#
# Spec note: ERD §8 describes the dashboard as a "separate process from
# skillscript-runtime, communicating via MCP server contract." V1 ships
# them colocated in one node process (smaller deployment footprint).
# v1.x can split into two images when multi-tenant or independent-scale
# deployments need it.

FROM node:22-alpine AS build
WORKDIR /app

# Install deps first to leverage Docker layer caching on source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY scaffold ./scaffold
COPY examples ./examples

RUN pnpm run build

# ─── Runtime image ──────────────────────────────────────────────────────────

FROM node:22-alpine
WORKDIR /app

# Copy only what the runtime needs at execution time. No source, no
# dev dependencies, no tests.
COPY --from=build /app/dist ./dist
COPY --from=build /app/scaffold ./scaffold
COPY --from=build /app/examples ./examples
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Persistent state mounts. Operators bind-mount these from the host (or
# the docker-compose volume) to preserve skills + traces across restarts.
VOLUME ["/data"]
ENV SKILLSCRIPT_HOME=/data

# Dashboard binds 127.0.0.1 by default per kickoff criterion #12. In
# container deployments operators expose via reverse proxy or override
# the bind address via DASHBOARD_HOST=0.0.0.0 (with the understood
# trade-off — no auth in v1).
EXPOSE 7878

# Default: launch the dashboard. Override CMD for other usage:
#   docker run skillscript-runtime skillfile run examples/hello.skill.md
#   docker run skillscript-runtime skillfile lint <skill>
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["dashboard", "--port", "7878"]
