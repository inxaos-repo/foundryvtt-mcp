# syntax=docker/dockerfile:1
# Headless GM supervisor: headless Chromium (chromium-headless-shell) logged into
# Foundry as a dedicated GM user. See headless-gm/README.md.
FROM node:24-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright-core install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*
COPY supervisor.mjs ./
USER node
EXPOSE 8080
CMD ["node", "/app/supervisor.mjs"]
