# Multi-stage Dockerfile for skillscript-runtime.
# Final image: distroless/nodejs22-debian12 (small, no shell, no apt).
# Built for linux/amd64 and linux/arm64.

ARG NODE_VERSION=22

# ─── Build stage ──────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /work

# Copy manifests first to cache the install layer.
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate \
    && pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig*.json ./
COPY src ./src
COPY scaffold ./scaffold
COPY scripts ./scripts
# v0.13.5 — use `build:dist` (tsc + copy-dashboard-assets) rather than the full
# `build` chain. Full `build` runs scripts/check-published-paths.mjs which
# validates README.md links against `npm pack --dry-run --json`. That's
# build-for-publish validation; Docker produces a runtime image, not an npm
# tarball, so the link-check is irrelevant here and was causing ENOENT/
# missing-context failures (v0.13.3/.4 hindsight). The host + CI release
# pipeline + dogfood-t7's pack test still run the full chain.
RUN pnpm run build:dist

# Prune dev deps for the runtime image.
RUN pnpm prune --prod

# ─── Runtime stage ────────────────────────────────────────────────────────
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12

WORKDIR /app
COPY --from=build /work/dist ./dist
COPY --from=build /work/scaffold ./scaffold
COPY --from=build /work/node_modules ./node_modules
COPY --from=build /work/package.json ./package.json

# Default skillscript home — operators bind-mount a host directory to
# persist skills + memory. Volume declaration signals this is mutable state.
ENV SKILLSCRIPT_HOME=/data
VOLUME ["/data"]

ENTRYPOINT ["/nodejs/bin/node", "/app/dist/cli.js"]
CMD ["--help"]
