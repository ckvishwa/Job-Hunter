import http from "node:http";
import { defineConfig } from "astro/config";

// The browser only ever talks to this origin; /api is proxied to the TypeScript API on loopback.
// Same-origin proxying keeps the session cookie SameSite=Strict and avoids any CORS configuration.
const api = process.env.JH_API_URL ?? "http://127.0.0.1:8787";
// Keep-alive reuses connections to the API instead of opening a new loopback connection per request.
const proxy = { "/api": { target: api, changeOrigin: false, agent: new http.Agent({ keepAlive: true, maxSockets: 8 }) } };
// frame-ancestors cannot be set from a <meta> tag, so the UI server sends it (and X-Frame-Options) as headers.
const headers = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export default defineConfig({
  output: "static",
  server: { host: "127.0.0.1", port: Number(process.env.JH_WEB_PORT ?? 4321) },
  devToolbar: { enabled: false },
  vite: { server: { proxy, headers }, preview: { proxy, headers } },
});
