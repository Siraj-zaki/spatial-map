#!/bin/sh
# Writes the SPA's runtime settings (src/config/runtime.ts) from env.
set -eu

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

token="${SPATIAL_MAP_MAPBOX_TOKEN:-}"
if [ -z "$token" ]; then
  echo "spatial-map: SPATIAL_MAP_MAPBOX_TOKEN is empty — maps will not load (get a token at https://account.mapbox.com/access-tokens/)" >&2
fi

cat > /usr/share/nginx/html/config.js <<JS
window.__SPATIAL_MAP_CONFIG__ = {
  "mapboxToken": "$(json_escape "$token")",
  "termsUrl": "$(json_escape "${SPATIAL_MAP_TERMS_URL:-}")",
  "privacyUrl": "$(json_escape "${SPATIAL_MAP_PRIVACY_URL:-}")"
}
JS
