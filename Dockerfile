# x402 Facilitator v2 (TypeScript / Node)
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Non-root runtime user pinned to uid/gid 1000 (matches legacy ec2-user) so the
# original `-v $(pwd)/logs:/app/logs` bind mount keeps the same write permissions.
RUN groupadd -g 1000 appuser \
    && useradd -r -u 1000 -g 1000 -s /bin/false appuser \
    && mkdir -p logs \
    && chown -R appuser:appuser /app
USER appuser

# 8001: HTTP API, 9001: metrics/monitoring (config monitoring.port)
EXPOSE 8001 9001
CMD ["node", "dist/index.js"]
