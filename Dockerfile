# Companion app (Next.js) for running on a server next to NapCat.
# Built by deploy/compose.yaml; see deploy/README.md.

ARG NODE_IMAGE=node:20-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# npm registry mirror (the default registry is slow from mainland China).
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry ${NPM_REGISTRY}
# Debian package mirror (deb.debian.org crawls from mainland China; Aliyun's
# mirror is on its internal network for ECS).
ARG APT_MIRROR=mirrors.aliyun.com
RUN sed -i "s#deb.debian.org#${APT_MIRROR}#g" /etc/apt/sources.list.d/debian.sources
# Toolchain in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Cap the build's memory: the server is 2 GB and QQ keeps running during the
# build (see deploy/build-on-server.sh).
RUN NODE_OPTIONS=--max-old-space-size=768 npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
# Next 13.4's render workers listen on "localhost"; Node 20 resolves that to
# ::1 first while the router connects to 127.0.0.1 -> ECONNREFUSED in Linux
# containers. Prefer IPv4.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
COPY --from=build /app/package.json /app/next.config.js ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/companions ./companions
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
