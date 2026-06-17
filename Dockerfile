# ── Stage 1: Install deps & generate Prisma client ───────────────────────────
FROM oven/bun:1-alpine AS deps
# openssl diperlukan agar prisma generate mendeteksi OpenSSL 3.x
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json ./
RUN bun install
COPY prisma ./prisma
RUN bunx prisma generate

# ── Stage 2: Production runtime ───────────────────────────────────────────────
FROM oven/bun:1-alpine AS runner
LABEL maintainer="sansalfian"
LABEL org.opencontainers.image.title="geonera-scheduler"
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY prisma ./prisma
COPY package.json ./
USER bun
CMD ["bun", "run", "src/index.ts"]
