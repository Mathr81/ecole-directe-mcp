# Built natively on the VPS (Oracle Ampere, arm64) — no --platform here on
# purpose. From an x86 machine, `docker buildx build --platform linux/arm64`
# works but goes through QEMU emulation and is markedly slower. Never build
# both platforms in one command.
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Session and device id live on the mounted volume. The device id especially:
# École Directe ties the QCM exemption to it, so losing it on every container
# recreation would mean answering the security questionnaire every time.
ENV SESSION_PATH=/data/session.json \
    DEVICE_ID_PATH=/data/device-id \
    DOWNLOAD_DIR=/data/downloads \
    MCP_HTTP_PORT=8787
# 0.0.0.0 is correct *inside* the container — the network namespace is its
# own. The isolation comes from docker-compose publishing the port on the
# Tailscale address only, never on the host's public interface.
ENV MCP_HTTP_HOST=0.0.0.0

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve", "--http"]
