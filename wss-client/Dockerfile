# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.16.0

FROM node:${NODE_VERSION}-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY config.example.json ./
COPY src ./src

VOLUME ["/app/config"]

USER node

CMD ["node", "src/index.js", "/app/config/config.json"]
