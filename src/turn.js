import { DEFAULT_TURN_TTL_SECONDS } from "./config.js";
import { corsHeaders, jsonWithCors } from "./http.js";

/**
 * Mint short-lived Cloudflare Realtime TURN credentials for Moonlight Web.
 * Long-term TURN key stays in Worker secrets (never shipped in server .env / releases).
 * Home servers call this via POST; allow Access Bypass for this path.
 */
export async function handleTurnIceServers(request, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonWithCors(request, { error: "Method not allowed" }, 405);
  }

  const keyId = String(env.CLOUDFLARE_TURN_KEY_ID || "").trim();
  const apiToken = String(env.CLOUDFLARE_TURN_API_TOKEN || "").trim();
  if (!keyId || !apiToken) {
    return jsonWithCors(
      request,
      {
        error: "Cloudflare TURN is not configured on the tunnel manager",
        detail: "Set Worker secrets CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN.",
      },
      503,
    );
  }

  let ttl = DEFAULT_TURN_TTL_SECONDS;
  if (request.method === "POST") {
    try {
      const body = await request.json();
      const requested = Number(body?.ttl);
      if (Number.isFinite(requested) && requested > 0) {
        ttl = Math.min(requested, 172_800);
      }
    } catch {
      // empty / non-JSON body → default ttl
    }
  }

  const upstream = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl }),
    },
  );

  const text = await upstream.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!upstream.ok) {
    return jsonWithCors(
      request,
      {
        error: "TURN credential generation failed",
        detail: text.slice(0, 200),
      },
      502,
    );
  }

  const iceServers = toMoonlightIceServers(payload);
  if (iceServers.length === 0) {
    return jsonWithCors(request, { error: "TURN returned no usable ICE servers" }, 502);
  }

  return new Response(JSON.stringify(iceServers), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(request, { methods: "GET, POST, OPTIONS" }),
    },
  });
}

function filterBrowserSafeTurnUrls(urls) {
  return (Array.isArray(urls) ? urls : []).filter((url) => {
    const value = String(url || "");
    return value.length > 0 && !/:53(?:\?|$)/.test(value);
  });
}

function toMoonlightIceServers(payload) {
  const list = Array.isArray(payload?.iceServers)
    ? payload.iceServers
    : Array.isArray(payload)
      ? payload
      : [];

  return list
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const urls = filterBrowserSafeTurnUrls(
        Array.isArray(entry.urls) ? entry.urls : entry.urls != null ? [entry.urls] : [],
      );
      if (urls.length === 0) return null;
      const out = { urls };
      if (typeof entry.username === "string" && entry.username) out.username = entry.username;
      if (typeof entry.credential === "string" && entry.credential) out.credential = entry.credential;
      return out;
    })
    .filter(Boolean);
}
