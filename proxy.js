export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = request.headers.get("Host") || url.hostname;

    if (url.pathname === "/" && hostname === "myhomegames-server.vige.it") {
      return new Response(HTML_LANDING, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/api/get-token") {
      if (request.method === "OPTIONS") {
        return corsPreflight(request);
      }
      return handleGetToken(request, env);
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleGetToken(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) {
    return jsonWithCors(request, { error: "Not authenticated" }, 401);
  }

  let email;
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1]));
    email = payload.email;
  } catch (e) {
    return jsonWithCors(request, { error: "Invalid token" }, 401);
  }

  if (!email) {
    return jsonWithCors(request, { error: "No email in token" }, 401);
  }

  const username = email.split("@")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const tunnelName = "MyHomeGames-" + username;
  const accountApi = "https://api.cloudflare.com/client/v4/accounts/" + env.MYGAMES_ACCOUNT_ID;
  const headers = { "Authorization": "Bearer " + env.MYGAMES_CF_API_TOKEN, "Content-Type": "application/json" };

  const listResp = await fetch(accountApi + "/cfd_tunnel?name=" + tunnelName, { headers });
  const listData = await listResp.json();

  if (listData.result && listData.result.length > 0) {
    const existingTunnel = listData.result[0];
    const tokenResp = await fetch(accountApi + "/cfd_tunnel/" + existingTunnel.id + "/token", { headers });
    const tokenData = await tokenResp.json();
    return jsonWithCors(request, {
      token: extractRunToken(tokenData),
      url: username + ".myhomegames-server.vige.it",
    });
  }

  const secret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const createResp = await fetch(accountApi + "/cfd_tunnel", {
    method: "POST", headers,
    body: JSON.stringify({ name: tunnelName, tunnel_secret: secret })
  });
  const createData = await createResp.json();

  if (!createData.success) {
    return jsonWithCors(
      request,
      { error: "Failed to create tunnel", details: createData.errors },
      500,
    );
  }

  const tunnelId = createData.result.id;

  await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/configurations", {
    method: "PUT", headers,
    body: JSON.stringify({
      config: {
        ingress: [
          { hostname: username + ".myhomegames-server.vige.it", service: "http://localhost:4000" },
          { service: "http_status:404" }
        ]
      }
    })
  });

  const zoneId = "243802546c0a2d88201fe78091fa3e84";
  const dnsHeaders = { "Authorization": "Bearer " + env.MYGAMES_CF_API_TOKEN, "Content-Type": "application/json" };

  await fetch("https://api.cloudflare.com/client/v4/zones/" + zoneId + "/dns_records", {
    method: "POST", headers: dnsHeaders,
    body: JSON.stringify({ type: "CNAME", name: username + ".myhomegames-server.vige.it", content: tunnelId + ".cfargotunnel.com", proxied: true })
  });

  const tokenResp = await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/token", { headers });
  const tokenData = await tokenResp.json();

  return jsonWithCors(request, {
    token: extractRunToken(tokenData),
    url: username + ".myhomegames-server.vige.it",
  });
}

/** Cloudflare returns run token as result string or result.token object. */
function extractRunToken(tokenData) {
  const result = tokenData?.result;
  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }
  if (result && typeof result.token === "string" && result.token.trim()) {
    return result.token.trim();
  }
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
    if (host.endsWith(".myhomegames-server.vige.it") || host === "myhomegames-server.vige.it") {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function corsPreflight(request) {
  const headers = {
    ...corsHeaders(request),
    "Access-Control-Max-Age": "86400",
  };
  return new Response(null, { status: 204, headers });
}

function jsonWithCors(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
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
