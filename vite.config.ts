import path from "path"
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Backend target for the dev-server proxy. Defaults to localhost:8080;
  // override with VITE_BACKEND_URL if your backend runs elsewhere.
  const backendUrl = env.VITE_BACKEND_URL ?? 'http://localhost:8080'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      // Listen on all interfaces so other devices on the LAN can
      // reach the dev server via the host machine's IP.
      host: true,
      proxy: {
        // Forward API + file requests to the Go backend so a browser
        // loading the frontend from another machine doesn't try to
        // hit `localhost:8080` (which would mean "on that client
        // machine" and fail). With this proxy, the frontend calls
        // same-origin `/api/v1/*` and `/files/*`, and Vite forwards
        // them to the backend running on the dev machine.
        //
        // IMPORTANT: the file proxy pattern is `/files/` (WITH trailing
        // slash), not `/files` — otherwise a hard refresh on the SPA
        // route `/files` proxies to the backend, which has no such
        // route and returns 404. Adding the slash means only actual
        // file URLs (`/files/<key>`) hit the backend; the bare
        // `/files` path falls through to Vite's SPA index.html.
        '/api': { target: backendUrl, changeOrigin: true },
        '/files/': { target: backendUrl, changeOrigin: true },
      },
    },
  }
})