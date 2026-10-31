# ============================================================================
# MONTE AZUR BACKEND — PRODUCTION MULTI-STAGE DOCKERFILE
# ============================================================================
# STAGE 1: Build & Compile TypeScript
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy source tree and compile
COPY src/ ./src/
RUN npm run build

# Prune development dependencies
RUN npm prune --production

# ============================================================================
# STAGE 2: Lightweight Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Copy runtime node_modules and compiled output
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY src/db/setup-gist.sql ./src/db/setup-gist.sql

# Non-root security user
USER node

EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
