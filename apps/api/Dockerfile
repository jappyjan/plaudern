# syntax=docker/dockerfile:1
# Production image for the Plaudern API. Multi-stage: compile the workspace with
# tsc+tsc-alias (decorator metadata preserved), then ship only the compiled
# output + production dependencies.

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm nx build api
# Self-contained production node_modules for the API (excludes dev deps).
#
# The `deploy:api` script pins `--config.node-linker=hoisted`, which is REQUIRED,
# not cosmetic. The compiled server is shipped as a flat `dist/server/...` tree
# with a single top-level node_modules, so at runtime Node resolves every
# `require(...)` by walking up to /app/node_modules. pnpm's default isolated
# linker only symlinks @plaudern/api's *direct* deps there; a workspace lib's own
# third-party deps (e.g. mailparser, declared only in @plaudern/email-ingest) land
# under a nested node_modules the flat dist tree never reaches -> MODULE_NOT_FOUND
# crash loop. Hoisting lifts every transitive dep to the top level so any lib
# dependency resolves. The same script backs `verify:prod-deps`, which fails CI if
# any prod dependency would be unresolvable in this layout.
RUN pnpm deploy:api /prod

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
# ffmpeg slices per-speaker clips for pyannoteAI voiceprint enrollment.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /repo/dist/server ./dist/server
COPY --from=builder /prod/node_modules ./node_modules

EXPOSE 3000
# migrations run automatically on boot (PersistenceModule, unless DATABASE_SYNCHRONIZE=true)
CMD ["node", "dist/server/apps/api/src/main.js"]
