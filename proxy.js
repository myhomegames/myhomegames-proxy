export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = request.headers.get("Host") || url.hostname;

    if (url.pathname === "/" && hostname === "myhomegames-server.vige.it") {
      return new Response(HTML_LANDING, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/api/get-token") {
      return handleGetToken(request, env);
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleGetToken(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  let email;
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1]));
    email = payload.email;
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  if (!email) {
    return new Response(JSON.stringify({ error: "No email in token" }), { status: 401, headers: { "Content-Type": "application/json" } });
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
    return new Response(JSON.stringify({
      token: tokenData.result?.token || null,
      url: username + ".myhomegames-server.vige.it"
    }), { headers: { "Content-Type": "application/json" } });
  }

  const secret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const createResp = await fetch(accountApi + "/cfd_tunnel", {
    method: "POST", headers,
    body: JSON.stringify({ name: tunnelName, tunnel_secret: secret })
  });
  const createData = await createResp.json();

  if (!createData.success) {
    return new Response(JSON.stringify({ error: "Failed to create tunnel", details: createData.errors }), { status: 500, headers: { "Content-Type": "application/json" } });
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

  return new Response(JSON.stringify({
    token: tokenData.result?.token || null,
    url: username + ".myhomegames-server.vige.it"
  }), { headers: { "Content-Type": "application/json" } });
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
