FROM node:22-alpine AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/server
COPY --chown=node:node --from=build /app/server/package.json /app/server/package-lock.json ./
COPY --chown=node:node --from=build /app/server/node_modules ./node_modules
COPY --chown=node:node --from=build /app/server/dist ./dist
RUN mkdir -p /app/server/data/artifacts && chown -R node:node /app/server/data
USER node
EXPOSE 8787
CMD ["node", "dist/runtime/start.js"]
