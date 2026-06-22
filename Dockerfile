FROM node:20-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node package-lock.json ./
COPY --chown=node:node tsconfig.json tsconfig.client.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public
COPY --chown=node:node assets ./assets

RUN npm ci && npm run build && npm prune --omit=dev
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
ENV LEADERBOARD_DATA_DIR=/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/status >/dev/null || exit 1

CMD ["node", "dist/server/index.js"]
