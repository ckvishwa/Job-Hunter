import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildDashboardSnapshot, type DashboardSources } from "./model.js";
import { DASHBOARD_HTML } from "./page.js";

// Loopback-only, GET/HEAD-only. The Host header must name a loopback host, which blocks DNS-rebinding
// reads from a web page the user happens to have open. Nothing here writes to any store.

export const LOOPBACK_HOST = "127.0.0.1";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
} as const;

function hostAllowed(header: string | undefined): boolean {
  if (!header) return false;
  const host = header.replace(/:\d+$/, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

export function createDashboardServer(sources: DashboardSources): http.Server {
  return http.createServer((req, res) => {
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS, ...extra });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain; charset=utf-8", "read-only", { Allow: "GET, HEAD" });
    if (!hostAllowed(req.headers.host)) return send(403, "text/plain; charset=utf-8", "forbidden host");
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/") return send(200, "text/html; charset=utf-8", DASHBOARD_HTML);
    if (pathname === "/api/snapshot") {
      try {
        return send(200, "application/json; charset=utf-8", JSON.stringify(buildDashboardSnapshot(sources)));
      } catch (error) {
        return send(500, "application/json; charset=utf-8", JSON.stringify({ error: error instanceof Error ? error.name : "UnknownError" }));
      }
    }
    return send(404, "text/plain; charset=utf-8", "not found");
  });
}

export function listenLoopback(server: http.Server, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, () => resolve(server.address() as AddressInfo));
  });
}
