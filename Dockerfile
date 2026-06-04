FROM node:20-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node package-lock.json ./
COPY --chown=node:node tsconfig.json tsconfig.client.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node assets ./assets

RUN npm ci && npm run build && npm prune --omit=dev

ENV NODE_ENV=production

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/snapshot >/dev/null || exit 1

CMD ["node", "dist/server/index.js"]
