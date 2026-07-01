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
RUN pnpm --filter=@plaudern/api --prod --legacy deploy /prod

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /repo/dist/server ./dist/server
COPY --from=builder /prod/node_modules ./node_modules

EXPOSE 3000
# migrations run automatically on boot (PersistenceModule, unless DATABASE_SYNCHRONIZE=true)
CMD ["node", "dist/server/apps/api/src/main.js"]
