# syntax=docker/dockerfile:1
# Production image for the Plaudern web SPA. Multi-stage: Vite build of the
# workspace, then a static nginx that also proxies /api to the api service.

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder
RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm nx build web

# ---------- runtime ----------
FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
