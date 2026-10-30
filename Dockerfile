FROM node:25-alpine

ENV NODE_ENV=production \
    RDRIVE_DATA=/data \
    PORT=8443

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js mcp.js ./
COPY lib ./lib
COPY public ./public

# Run as the unprivileged "node" user; files, accounts and certificates live in /data.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "lib/healthcheck.js"]
CMD ["node", "server.js"]
