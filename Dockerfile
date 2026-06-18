# x402 Facilitator v2 (TypeScript / Node)
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# vendored @bankofai/x402-* tarballs referenced via file: in package.json (dev phase)
COPY vendor ./vendor
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY vendor ./vendor
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8001
CMD ["node", "dist/index.js"]
