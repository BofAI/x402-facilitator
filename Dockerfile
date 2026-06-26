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
# node:22-slim already ships a uid/gid 1000 `node` user, so create only if absent
# and run by numeric uid to stay independent of the account name.
RUN (getent group 1000 >/dev/null || groupadd -g 1000 appuser) \
    && (getent passwd 1000 >/dev/null || useradd -r -u 1000 -g 1000 -s /bin/false appuser) \
    && mkdir -p logs \
    && chown -R 1000:1000 /app
USER 1000

# 8001: HTTP API, 9001: metrics/monitoring (config monitoring.port)
EXPOSE 8001 9001
CMD ["node", "dist/index.js"]
