# syntax=docker/dockerfile:1
# foundryvtt-mcp behind supergateway: stdio MCP -> streamable HTTP on :8000 (/mcp)
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN bun run build
RUN rm -rf node_modules && bun install --frozen-lockfile --production --ignore-scripts

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g supergateway@4.2.0 && npm cache clean --force
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8000
# Stateful: one stdio child (= one Foundry socket login) per MCP session.
CMD ["supergateway", "--stdio", "node /app/dist/index.js", "--outputTransport", "streamableHttp", "--stateful", "--sessionTimeout", "900000", "--port", "8000", "--streamableHttpPath", "/mcp", "--healthEndpoint", "/healthz"]
