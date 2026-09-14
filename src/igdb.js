import { IGDB_GATEWAY_PREFIX } from "./config.js";
import { isTunnelUserHost } from "./hostnames.js";

export async function handleIgdbGatewayRelay(request, env) {
  const incoming = new URL(request.url);
  const tunnelHost = String(request.headers.get("X-MHG-Tunnel-Host") || "").trim().toLowerCase();
  const igdbPath = incoming.pathname.slice(IGDB_GATEWAY_PREFIX.length) || "/";

  if (!isTunnelUserHost(tunnelHost)) {
    return new Response("X-MHG-Tunnel-Host must be a user tunnel hostname", { status: 400 });
  }
  if (!isIgdbPath(igdbPath)) {
    return new Response("Path must be under /igdb/", { status: 400 });
  }

  return forwardIgdbToTunnel(request, env, tunnelHost, igdbPath, incoming.search);
}

export async function forwardIgdbToTunnel(request, env, tunnelHost, pathnameOverride, searchOverride) {
  const incoming = new URL(request.url);
  const igdbPath =
    pathnameOverride ??
    (isIgdbPath(incoming.pathname) ? incoming.pathname : incoming.pathname.slice(IGDB_GATEWAY_PREFIX.length) || "/");
  const search = searchOverride ?? incoming.search;

  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    return new Response("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET secrets are missing", { status: 500 });
  }

  const target = new URL(igdbPath + search, originBase(env, tunnelHost));
  const headers = new Headers(request.headers);
  headers.delete("X-Twitch-Client-Id");
  headers.delete("X-Twitch-Client-Secret");
  headers.delete("X-MHG-Tunnel-Host");
  if (env.TWITCH_CLIENT_ID) headers.set("X-Twitch-Client-Id", env.TWITCH_CLIENT_ID);
  if (env.TWITCH_CLIENT_SECRET) headers.set("X-Twitch-Client-Secret", env.TWITCH_CLIENT_SECRET);

  return fetch(new Request(target.toString(), {
    method: request.method,
    headers,
    body: request.body ?? undefined,
    redirect: "manual",
  }));
}

export function isIgdbPath(pathname) {
  return pathname === "/igdb" || pathname.startsWith("/igdb/");
}

function originBase(env, hostname) {
  if (isTunnelUserHost(hostname)) {
    return `https://${hostname}`;
  }
  const host = (env.ORIGIN_HTTP_HOST || "127.0.0.1").trim();
  const port = (env.ORIGIN_HTTP_PORT || "4000").trim();
  return `http://${host}:${port}`;
}
