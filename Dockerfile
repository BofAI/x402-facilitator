# x402 Facilitator v2 (TypeScript / Node)
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
# CVE-2026-111497: use Bookworm's patched system Brotli in both stages.
# DLA-4941-1: install the corrected Bookworm PAM build for CVE-2025-6020.
# Fail the build if the configured Debian repositories do not provide the fix.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libbrotli1 libpam-modules \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge '1.0.9-2+deb12u1' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpam-modules)" ge '1.5.2-6+deb12u3' \
    && rm -rf /var/lib/apt/lists/*
# Refresh npm's bundled brace-expansion and Undici in both image stages.
RUN npm install --global --no-audit --no-fund npm@11.21.3

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:29ee70762214fe8190cea04ef1c0a84a8365879e047ce8f911ae5a5ab2355fa2 AS runtime-library-source

FROM base AS production-deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
# Preserve the runtime uid, gid and wallet home used by existing deployments.
RUN groupmod -n ec2-user node \
    && usermod -l ec2-user -d /home/ec2-user -m node \
    && mkdir -p /app/logs \
    && chown -R 1000:1000 /app /home/ec2-user

# Keep the C++ runtime and patched zlib with their Debian metadata and notices.
RUN --mount=from=runtime-library-source,target=/distroless,ro \
    mkdir -p /runtime-libs \
    && cd /distroless \
    && cp -a --parents \
        usr/lib/*/libgcc_s.so.1 usr/lib/*/libstdc++.so.6* usr/lib/*/libz.so.1* \
        var/lib/dpkg/status.d/gcc-14-base* var/lib/dpkg/status.d/libgcc-s1* \
        var/lib/dpkg/status.d/libstdc++6* var/lib/dpkg/status.d/zlib1g* \
        usr/share/doc/gcc-14-base usr/share/doc/libgcc-s1 \
        usr/share/doc/libstdc++6 usr/share/doc/zlib1g /runtime-libs/

# Node provides TLS through its embedded OpenSSL. Use the Debian 13 base
# without the system libssl3t64 package (CVE-2026-107494, CVE-2026-124709).
FROM gcr.io/distroless/base-nossl-debian13:nonroot@sha256:4006ac92504be607b70de01d1f64f38288c69fcd8faa820f6d3aed266ea32ac5 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOME=/home/ec2-user
COPY --from=production-deps /runtime-libs/ /
COPY --from=production-deps /usr/local/bin/node /usr/local/bin/node
# Wallet-cli uses an env-based Node shebang. Keep sh for mounted launch wrappers.
COPY --from=production-deps /usr/bin/env /usr/bin/env
COPY --from=production-deps /usr/bin/dash /bin/sh
COPY --from=production-deps /etc/passwd /etc/group /etc/
COPY --from=production-deps --chown=1000:1000 /home/ec2-user/ /home/ec2-user/
COPY --from=production-deps --chown=1000:1000 /app/ /app/
COPY --from=build /app/dist ./dist
# Bake the non-secret environment configs into the image. They contain only
# 1Password references; Connect credentials are injected at runtime.
# Copy explicitly so a local config/facilitator.config.yaml is never included.
COPY config/facilitator.config.dev.yaml ./config/facilitator.config.dev.yaml
COPY config/facilitator.config.prod.yaml ./config/facilitator.config.prod.yaml

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
# so it works in the minimal runtime image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||'8001')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
