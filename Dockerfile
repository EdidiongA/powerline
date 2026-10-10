# Powerline — Alexa+ home power copilot (MCP server over Streamable HTTP)
#
#   docker build -t powerline .
#   docker run -p 3000:3000 powerline                         # simulator, open endpoint
#   docker run -p 3000:3000 -e API_TOKENS=home:$(openssl rand -hex 16) powerline
#
# Multi-stage: build the MCP App views and TypeScript, then ship only what runs.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The process runs as `node`; a named volume mounted at /data is created root-owned unless the
# image already has the directory with the right owner. Without this the store cannot write
# and /healthz reports 503.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz | grep -q '"ok":true' || exit 1
CMD ["node", "dist/http.js"]
