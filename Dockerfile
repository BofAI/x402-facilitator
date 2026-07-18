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

# Non-root runtime user matching legacy v1 exactly: `ec2-user` at uid/gid 1000 with
# HOME /home/ec2-user. The ops `docker run` bind-mounts the provisioned agent-wallet
# store at ~/.agent-wallet (agent-wallet's default = homedir()/.agent-wallet), so the
# runtime user and HOME must match v1 or `resolveWallet` finds no active wallet.
# node:22-slim ships uid/gid 1000 as `node`; rename it rather than add a second one.
RUN groupmod -n ec2-user node \
    && usermod -l ec2-user -d /home/ec2-user -m node \
    && mkdir -p /app/logs \
    && chown -R 1000:1000 /app /home/ec2-user
ENV HOME=/home/ec2-user
USER ec2-user

# 8001: HTTP API, 9001: metrics/monitoring (config monitoring.port)
EXPOSE 8001 9001

# The HTTP listen port is read from YAML (server.port, default 8001) but can be
# overridden by SERVER_PORT env. The container pins SERVER_PORT=8001 so the health
# probe and the actual listen port always agree without mounting a config file.
# To run on a different port, override ENV SERVER_PORT, EXPOSE, and the HEALTHCHECK
# target together.
ENV SERVER_PORT=8001
# /health returns 200 with no auth or rate-limit. Polls every 30s with a 5s
# timeout; 3 consecutive failures mark the container unhealthy. Uses `node -e`
# so it works on node:22-slim (which ships neither wget nor curl).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||'8001')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
