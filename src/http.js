import {
  MANAGER_HOST,
  USER_TUNNEL_HOST_SUFFIX,
} from "./config.js";

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function htmlPage(title, bodyHtml, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — MyHomeGames</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: system-ui, -apple-system, Segoe UI, sans-serif;
      background: #0b0b0c; color: #f2f2f2;
    }
    main {
      width: min(420px, 92vw); padding: 2rem;
      border: 1px solid rgba(255,255,255,.12); border-radius: 16px;
      background: rgba(255,255,255,.04);
    }
    h1 { margin: 0 0 .75rem; font-size: 1.4rem; }
    p { margin: 0 0 .75rem; color: rgba(255,255,255,.75); line-height: 1.45; }
    a { color: #e5a00d; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function corsHeaders(request, { methods = "GET, OPTIONS" } = {}) {
  const origin = request.headers.get("Origin");
  if (!origin || !isAllowedCorsOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, Cf-Access-Jwt-Assertion",
  };
}

export function isAllowedCorsOrigin(origin) {
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (host.endsWith(USER_TUNNEL_HOST_SUFFIX)) return true;
    if (host === MANAGER_HOST) return true;
    if (host.endsWith(".myhomegames.vige.it") || host === "myhomegames.vige.it") return true;
  } catch {
    return false;
  }
  return false;
}

export function corsPreflight(request, options) {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(request, options), "Access-Control-Max-Age": "86400" },
  });
}

export function jsonWithCors(request, data, status = 200, options) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, options) },
  });
}
