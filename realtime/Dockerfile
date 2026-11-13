FROM node:20-alpine

LABEL description="Housiy realtime WebSocket gateway"
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./

# Unprivileged user shipped with the node image.
USER node
EXPOSE 8090

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8090/healthz || exit 1

CMD ["node", "server.js"]
