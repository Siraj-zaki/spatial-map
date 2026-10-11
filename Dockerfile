# Spatial Map web app: the built SPA behind nginx, which also proxies
# /api/ and /files/ to the Go API (docker/web/default.conf.template).
# The Mapbox token and legal links are set at container start from env
# (docker/web/40-spatial-map-config.sh), not baked in at build time.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY docker/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/web/40-spatial-map-config.sh /docker-entrypoint.d/40-spatial-map-config.sh
RUN chmod +x /docker-entrypoint.d/40-spatial-map-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
# nginx runs as an unprivileged user: make sure every file is world-readable
# (a 0600 source file would otherwise 403 and silently drop translations).
RUN chmod -R a+rX /usr/share/nginx/html
ENV SPATIAL_MAP_API_UPSTREAM=http://api:8080
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
