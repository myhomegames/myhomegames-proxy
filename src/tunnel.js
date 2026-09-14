import { MOONLIGHT_WEB_LOCAL_PORT, ZONE_ID } from "./config.js";
import { userTunnelHostname, userMoonlightWebHostname, usernameFromEmail } from "./hostnames.js";
import { ensureDnsCname } from "./dns.js";

/**
 * Create or fetch the Cloudflare Tunnel for this Access identity.
 * Shared by browser get-token and TV device-code approve.
 */
export async function mintTunnelForEmail(env, email) {
  const username = usernameFromEmail(email);
  const tunnelName = "MyHomeGames-" + username;
  const accountApi = "https://api.cloudflare.com/client/v4/accounts/" + env.MYGAMES_ACCOUNT_ID;
  const headers = { Authorization: "Bearer " + env.MYGAMES_CF_API_TOKEN, "Content-Type": "application/json" };

  const listResp = await fetch(accountApi + "/cfd_tunnel?name=" + tunnelName, { headers });
  const listData = await listResp.json();

  if (listData.result && listData.result.length > 0) {
    const tunnelId = listData.result[0].id;
    await ensureUserTunnelRouting(accountApi, tunnelId, username, headers);
    const tokenResp = await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/token", { headers });
    const tokenData = await tokenResp.json();
    const token = extractRunToken(tokenData);
    if (!token) {
      return { error: "missing_token" };
    }
    return { token, url: userTunnelHostname(username) };
  }

  const secret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const createResp = await fetch(accountApi + "/cfd_tunnel", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: tunnelName, tunnel_secret: secret }),
  });
  const createData = await createResp.json();

  if (!createData.success) {
    return { error: "create_tunnel_failed", details: createData.errors };
  }

  const tunnelId = createData.result.id;
  await ensureUserTunnelRouting(accountApi, tunnelId, username, headers);

  const tokenResp = await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/token", { headers });
  const tokenData = await tokenResp.json();
  const token = extractRunToken(tokenData);
  if (!token) {
    return { error: "missing_token" };
  }
  return { token, url: userTunnelHostname(username) };
}

export async function ensureUserTunnelRouting(accountApi, tunnelId, username, headers) {
  const hostname = userTunnelHostname(username);
  const moonlightHostname = userMoonlightWebHostname(username);
  await fetch(accountApi + "/cfd_tunnel/" + tunnelId + "/configurations", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      config: {
        ingress: [
          { hostname, service: "http://localhost:4000" },
          { hostname: moonlightHostname, service: `http://localhost:${MOONLIGHT_WEB_LOCAL_PORT}` },
          { service: "http_status:404" },
        ],
      },
    }),
  });
  const tunnelTarget = tunnelId + ".cfargotunnel.com";
  await ensureDnsCname(ZONE_ID, headers, hostname, tunnelTarget);
  await ensureDnsCname(ZONE_ID, headers, moonlightHostname, tunnelTarget);
}


export function extractRunToken(tokenData) {
  const result = tokenData?.result;
  if (typeof result === "string" && result.trim()) return result.trim();
  if (result && typeof result.token === "string" && result.token.trim()) return result.token.trim();
  return null;
}
