import {
  MANAGER_HOST,
  USER_TUNNEL_HOST_SUFFIX,
} from "./config.js";
import { emailFromAccessJwt } from "./access-auth.js";
import { jsonWithCors } from "./http.js";
import { mintTunnelForEmail } from "./tunnel.js";

export function isAllowedReturnUrl(raw) {
  try {
    const u = new URL(raw);
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

export function redirectToReturnUrl(returnTo, params = {}) {
  const dest = new URL(returnTo);
  for (const [key, value] of Object.entries(params)) {
    dest.searchParams.set(key, value);
  }
  return Response.redirect(dest.toString(), 302);
}

export function encodeTunnelReturnHash(payload) {
  const json = JSON.stringify({
    token: payload.token,
    url: payload.url,
  });
  const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `tunnel=${b64}`;
}

export function readReturnToCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)mhg_return_to=([^;]*)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return "";
  }
}

export function appendReturnToCookie(headers, returnTo) {
  headers.append(
    "Set-Cookie",
    `mhg_return_to=${encodeURIComponent(returnTo)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
  );
}

/** Browser OAuth return: pass token in URL fragment so the SPA can POST /tunnel/connect without cross-origin fetch. */
export function redirectToAppWithTunnel(returnTo, payload) {
  const dest = new URL(returnTo);
  dest.searchParams.set("tunnel_auth", "ok");
  dest.hash = encodeTunnelReturnHash(payload);
  const headers = new Headers({ Location: dest.toString() });
  appendReturnToCookie(headers, returnTo);
  return new Response(null, { status: 302, headers });
}

export function decodeBase64Url(value) {
  const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return atob(padded + "=".repeat(padLen));
}

/** return_to from path (/api/get-token/r/<b64url>) survives Access logout redirects. */
export function parseGetTokenReturnTo(requestUrl) {
  const prefix = "/api/get-token/r/";
  const pathname = requestUrl.pathname;
  if (pathname.startsWith(prefix) && pathname.length > prefix.length) {
    try {
      const decoded = decodeBase64Url(pathname.slice(prefix.length)).trim();
      if (decoded) return decoded;
    } catch {
      // fall through
    }
  }
  return requestUrl.searchParams.get("return_to")?.trim() || "";
}

export async function handleGetToken(request, env) {
  const requestUrl = new URL(request.url);

  if (requestUrl.searchParams.has("__cf_access_message")) {
    const cleaned = new URL(requestUrl);
    cleaned.searchParams.delete("__cf_access_message");
    const headers = new Headers({ Location: cleaned.toString() });
    const cleanedReturnTo = parseGetTokenReturnTo(cleaned);
    if (cleanedReturnTo && isAllowedReturnUrl(cleanedReturnTo)) {
      appendReturnToCookie(headers, cleanedReturnTo);
    }
    return new Response(null, { status: 302, headers });
  }

  const returnTo = parseGetTokenReturnTo(requestUrl);
  let browserReturnTo = returnTo && isAllowedReturnUrl(returnTo) ? returnTo : "";
  if (!browserReturnTo) {
    const fromCookie = readReturnToCookie(request);
    if (fromCookie && isAllowedReturnUrl(fromCookie)) {
      browserReturnTo = fromCookie;
    }
  }

  const identity = emailFromAccessJwt(request);
  if (identity.error) {
    if (browserReturnTo) {
      return redirectToReturnUrl(browserReturnTo, { tunnel_auth: "error", reason: identity.error });
    }
    return jsonWithCors(request, { error: "Not authenticated" }, 401);
  }

  if (!browserReturnTo) {
    const fallback = String(env.DEFAULT_APP_RETURN_URL || "").trim();
    if (fallback && isAllowedReturnUrl(fallback)) {
      browserReturnTo = fallback;
    }
  }

  const minted = await mintTunnelForEmail(env, identity.email);
  if (minted.error) {
    if (browserReturnTo) {
      return redirectToReturnUrl(browserReturnTo, { tunnel_auth: "error", reason: minted.error });
    }
    const status = minted.error === "create_tunnel_failed" ? 500 : 502;
    return jsonWithCors(
      request,
      { error: minted.error === "create_tunnel_failed" ? "Failed to create tunnel" : "Missing tunnel token", details: minted.details },
      status,
    );
  }

  const payload = { token: minted.token, url: minted.url };
  if (browserReturnTo) {
    return redirectToAppWithTunnel(browserReturnTo, payload);
  }
  return jsonWithCors(request, payload);
}
