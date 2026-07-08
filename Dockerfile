# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.16.0

FROM node:${NODE_VERSION}-alpine AS backend-builder
WORKDIR /src/backend

RUN corepack enable

COPY backend/package.json backend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY backend/ ./
RUN pnpm run bundle:esbuild

FROM node:${NODE_VERSION}-alpine AS frontend-builder
WORKDIR /src/frontend

RUN corepack enable

COPY --from=frontend .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY --from=frontend .env .env.production .env.development index.html tsconfig.json tsconfig.node.json vite.config.ts ./
COPY --from=frontend public ./public
COPY --from=frontend scripts ./scripts
COPY --from=frontend src ./src
ENV VITE_API_URL=/backend \
    VITE_PUBLIC_PATH=/
RUN pnpm run build

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /opt/app

RUN apk add --no-cache ca-certificates tzdata \
    && mkdir -p /opt/app/data /opt/app/frontend

ENV TZ=Asia/Shanghai \
    TIME_ZONE=Asia/Shanghai \
    SUB_STORE_BACKEND_API_HOST=0.0.0.0 \
    SUB_STORE_BACKEND_API_PORT=3000 \
    SUB_STORE_BACKEND_MERGE=true \
    SUB_STORE_FRONTEND_BACKEND_PATH=/backend \
    SUB_STORE_FRONTEND_PATH=/opt/app/frontend \
    SUB_STORE_DATA_BASE_PATH=/opt/app/data

COPY --from=backend-builder /src/backend/dist/sub-store.bundle.js /opt/app/sub-store.bundle.js
COPY --from=frontend-builder /src/frontend/dist /opt/app/frontend

EXPOSE 3000
VOLUME ["/opt/app/data"]

CMD ["node", "/opt/app/sub-store.bundle.js"]
