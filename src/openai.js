import { isTunnelUserHost } from "./hostnames.js";

/** Paths that need the shared OpenAI-compatible key (folder import). */
export function isOpenAiCredentialPath(pathname) {
  return (
    pathname === "/games/import-from-folder" ||
    pathname === "/games/pick-import-folder" ||
    pathname.startsWith("/games/import-from-folder/") ||
    pathname.startsWith("/games/pick-import-folder/")
  );
}

export function isSettingsPath(pathname) {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/**
 * Strip client-spoofed OpenAI headers, then inject Worker secrets/vars.
 * Mirrors Twitch X-Twitch-Client-* injection in igdb.js.
 */
export function applyOpenAiCredentialHeaders(headers, env) {
  headers.delete("X-OpenAI-Api-Key");
  headers.delete("X-OpenAI-Base-Url");
  headers.delete("X-OpenAI-Model");
  headers.delete("X-MHG-Ai-Configured");

  const apiKey = String(env.OPENAI_API_KEY || env.MHG_AI_API_KEY || "").trim();
  const baseURL = String(env.OPENAI_BASE_URL || env.MHG_AI_BASE_URL || "").trim();
  const model = String(env.OPENAI_MODEL || env.MHG_AI_MODEL || "").trim();

  if (apiKey) headers.set("X-OpenAI-Api-Key", apiKey);
  if (baseURL) headers.set("X-OpenAI-Base-Url", baseURL);
  if (model) headers.set("X-OpenAI-Model", model);
  headers.set("X-MHG-Ai-Configured", apiKey ? "true" : "false");
  return Boolean(apiKey);
}

/**
 * Forward folder-import API calls to the user tunnel with OpenAI credentials injected.
 */
export async function forwardOpenAiProtectedToTunnel(request, env, tunnelHost) {
  if (!isTunnelUserHost(tunnelHost)) {
    return new Response("Host must be a user tunnel hostname", { status: 400 });
  }

  const apiKey = String(env.OPENAI_API_KEY || env.MHG_AI_API_KEY || "").trim();
  if (!apiKey) {
    return new Response("OPENAI_API_KEY secret is missing", { status: 500 });
  }

  return forwardToTunnel(request, env, tunnelHost, { injectOpenAi: true });
}

/**
 * Forward /settings so the origin can learn whether AI is configured on the gateway
 * without exposing the API key in the JSON body.
 */
export async function forwardSettingsToTunnel(request, env, tunnelHost) {
  if (!isTunnelUserHost(tunnelHost)) {
    return new Response("Host must be a user tunnel hostname", { status: 400 });
  }
  return forwardToTunnel(request, env, tunnelHost, { injectOpenAi: true, credentialsOptional: true });
}

async function forwardToTunnel(request, env, tunnelHost, options = {}) {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, originBase(env, tunnelHost));
  const headers = new Headers(request.headers);
  headers.delete("X-MHG-Tunnel-Host");

  if (options.injectOpenAi) {
    const hasKey = applyOpenAiCredentialHeaders(headers, env);
    if (!hasKey && !options.credentialsOptional) {
      return new Response("OPENAI_API_KEY secret is missing", { status: 500 });
    }
  }

  return fetch(
    new Request(target.toString(), {
      method: request.method,
      headers,
      body: request.body ?? undefined,
      redirect: "manual",
    })
  );
}

function originBase(env, hostname) {
  if (isTunnelUserHost(hostname)) {
    return `https://${hostname}`;
  }
  const host = (env.ORIGIN_HTTP_HOST || "127.0.0.1").trim();
  const port = (env.ORIGIN_HTTP_PORT || "4000").trim();
  return `http://${host}:${port}`;
}
