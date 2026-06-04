const MANAGER_HOST = "myhomegames-server.vige.it";
const IGDB_GATEWAY_PREFIX = "/api/igdb-gateway";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = request.headers.get("Host") || url.hostname;
    const route = pickRoute(hostname, url.pathname, request.method);

    if (route === "igdb-gateway-relay") {
      return handleIgdbGatewayRelay(request, env);
    }
    if (route === "igdb-subdomain") {
      return forwardIgdbToTunnel(request, env, hostname);
    }
    if (route === "landing") {
      return new Response(HTML_LANDING, { headers: { "Content-Type": "text/html" } });
    }
    if (route === "get-token-options") {
      return corsPreflight(request);
    }
    if (route === "get-token") {
      return handleGetToken(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

function pickRoute(hostname, pathname, method) {
  if (hostname === MANAGER_HOST && pathname.startsWith(`${IGDB_GATEWAY_PREFIX}/`)) {
    return "igdb-gateway-relay";
  }
  if (isIgdbPath(pathname) && isTunnelUserHost(hostname)) {
    return "igdb-subdomain";
  }
  if (pathname === "/" && hostname === MANAGER_HOST) {
    return "landing";
  }
  if (pathname === "/api/get-token" && hostname === MANAGER_HOST) {
    return method === "OPTIONS" ? "get-token-options" : "get-token";
  }
  return "unmatched";
}

async function handleIgdbGatewayRelay(request, env) {
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

async function forwardIgdbToTunnel(request, env, tunnelHost, pathnameOverride, searchOverride) {
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

function isTunnelUserHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host.endsWith(".myhomegames-server.vige.it") && host !== "myhomegames-server.vige.it";
}

function isIgdbPath(pathname) {
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

async function handleGetToken(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return jsonWithCors(request, { error: "Not authenticated" }, 401);

  let email;
  try { email = JSON.parse(atob(jwt.split(".")[1])).email; } catch {
    return jsonWithCors(request, { error: "Invalid token" }, 401);
  }
  if (!email) return jsonWithCors(request, { error: "No email in token" }, 401);

  const username = email.split("@")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const tunnelName = "MyHomeGames-" + username;
  const accountApi = "https://api.cloudflare.com/client/v4/accounts/" + env.MYGAMES_ACCOUNT_ID;
  const headers = { Authorization: "Bearer " + env.MYGAMES_CF_API_TOKEN, "Content-Type": "application/json" };

  const listResp = await fetch(accountApi + "/cfd_tunnel?name=" + tunnelName, { headers });
  const listData = await listResp.json();

  if (listData.result && listData.result.length > 0) {
    const tokenResp = await fetch(accountApi + "/cfd_tunnel/" + listData.result[0].id + "/token", { headers });
    const tokenData = await tokenResp.json();
    return jsonWithCors(request, {
      token: extractRunToken(tokenData),
      url: username + ".myhomegames-server.vige.it",
    });
  }

  const secret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const createResp = await fetch(accountApi + "/cfd_tunnel", {
    method: "POST", headers,
    body: JSON.stringify({ name: tunnelName, tunnel_secret: secret }),
  });
  const createData = await createResp.json();

  if (!createData.success) {
    return jsonWithCors(request, { error: "Failed to create tunnel", details: createData.errors }, 500);
  }

  const tunnelId = createData.result.id;
  await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/configurations", {
    method: "PUT", headers,
    body: JSON.stringify({
      config: {
        ingress: [
          { hostname: username + ".myhomegames-server.vige.it", service: "http://localhost:4000" },
          { service: "http_status:404" },
        ],
      },
    }),
  });

  const zoneId = "243802546c0a2d88201fe78091fa3e84";
  await fetch("https://api.cloudflare.com/client/v4/zones/" + zoneId + "/dns_records", {
    method: "POST", headers,
    body: JSON.stringify({
      type: "CNAME",
      name: username + ".myhomegames-server.vige.it",
      content: tunnelId + ".cfargotunnel.com",
      proxied: true,
    }),
  });

  const tokenResp = await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/token", { headers });
  const tokenData = await tokenResp.json();

  return jsonWithCors(request, {
    token: extractRunToken(tokenData),
    url: username + ".myhomegames-server.vige.it",
  });
}

function extractRunToken(tokenData) {
  const result = tokenData?.result;
  if (typeof result === "string" && result.trim()) return result.trim();
  if (result && typeof result.token === "string" && result.token.trim()) return result.token.trim();
  return null;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (!origin || !isAllowedCorsOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cf-Access-Jwt-Assertion",
  };
}

function isAllowedCorsOrigin(origin) {
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (host.endsWith(".myhomegames-server.vige.it") || host === "myhomegames-server.vige.it") return true;
  } catch { return false; }
  return false;
}

function corsPreflight(request) {
  return new Response(null, { status: 204, headers: { ...corsHeaders(request), "Access-Control-Max-Age": "86400" } });
}

function jsonWithCors(request, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders(request) } });
}

const HTML_LANDING = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MyHomeGames</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#fff}
    .container{text-align:center;padding:2rem}
    h1{font-size:2.5rem;margin-bottom:.5rem}
    p{color:#aaa;margin-bottom:2rem}
    .btn{display:inline-block;padding:12px 32px;background:#f97316;color:#fff;text-decoration:none;border-radius:8px;font-size:1.1rem;font-weight:600;transition:background .2s}
    .btn:hover{background:#ea580c}
  </style>
</head>
<body>
  <div class="container">
    <h1>🎮 MyHomeGames</h1>
    <p>Connetti il tuo localhost:4000 a internet</p>
    <a href="/api/get-token" class="btn">Connetti</a>
  </div>
</body>
</html>`;
