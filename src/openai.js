import { isTunnelUserHost } from "./hostnames.js";
import { applyTwitchCredentialHeaders } from "./igdb.js";

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
 * Forward folder-import API calls to the user tunnel with OpenAI + Twitch credentials.
 * Twitch headers let the home server enrich games via IGDB the same way as single-game add.
 */
export async function forwardOpenAiProtectedToTunnel(request, env, tunnelHost) {
  if (!isTunnelUserHost(tunnelHost)) {
    return new Response("Host must be a user tunnel hostname", { status: 400 });
  }

  const apiKey = String(env.OPENAI_API_KEY || env.MHG_AI_API_KEY || "").trim();
  if (!apiKey) {
    return new Response("OPENAI_API_KEY secret is missing", { status: 500 });
  }

  return forwardToTunnel(request, env, tunnelHost, {
    injectOpenAi: true,
    injectTwitch: true,
  });
}

/**
 * Forward /settings so the origin can learn whether AI is configured on the gateway
 * without exposing the API key in the JSON body.
 */
export async function forwardSettingsToTunnel(request, env, tunnelHost) {
  if (!isTunnelUserHost(tunnelHost)) {
    return new Response("Host must be a user tunnel hostname", { status: 400 });
  }
  return forwardToTunnel(request, env, tunnelHost, {
    injectOpenAi: true,
    credentialsOptional: true,
  });
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

  // Optional: folder import searches IGDB on the home server; same secrets as /igdb/*.
  if (options.injectTwitch) {
    applyTwitchCredentialHeaders(headers, env);
  }

  const init = {
    method: request.method,
    headers,
    body: request.body ?? undefined,
    redirect: "manual",
  };
  // Required by the Fetch spec when forwarding a streaming request body.
  if (init.body != null) init.duplex = "half";

  const upstream = await fetch(new Request(target.toString(), init));

  // Long folder-import SSE: pipe through with edge keepalives so client↔Worker
  // does not idle-out while the home server is between progress events.
  if (options.injectTwitch && isEventStream(upstream)) {
    return pipeEventStreamWithKeepalive(upstream);
  }

  return upstream;
}

function isEventStream(response) {
  const ct = String(response.headers.get("content-type") || "").toLowerCase();
  return ct.includes("text/event-stream") && response.body != null;
}

/** Forward SSE and inject comment pings when the upstream is quiet. */
function pipeEventStreamWithKeepalive(upstream, intervalMs = 10_000) {
  const encoder = new TextEncoder();
  let lastWriteAt = Date.now();
  let pingTimer = null;
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();

  const stopPing = () => {
    if (pingTimer == null) return;
    clearInterval(pingTimer);
    pingTimer = null;
  };

  const writePing = () => {
    if (Date.now() - lastWriteAt < intervalMs) return;
    lastWriteAt = Date.now();
    writer.write(encoder.encode(`: ping ${Date.now()}\n\n`)).catch(() => {
      stopPing();
    });
  };

  pingTimer = setInterval(writePing, Math.max(3_000, Math.floor(intervalMs / 2)));

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastWriteAt = Date.now();
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      try {
        await writer.abort(err);
      } catch (_) {
        /* ignore */
      }
    } finally {
      stopPing();
      try {
        reader.releaseLock();
      } catch (_) {
        /* ignore */
      }
    }
  })();

  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-length");
  outHeaders.set("Cache-Control", "no-cache, no-transform");
  outHeaders.set("X-Accel-Buffering", "no");
  return new Response(readable, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

function originBase(env, hostname) {
  if (isTunnelUserHost(hostname)) {
    return `https://${hostname}`;
  }
  const host = (env.ORIGIN_HTTP_HOST || "127.0.0.1").trim();
  const port = (env.ORIGIN_HTTP_PORT || "4000").trim();
  return `http://${host}:${port}`;
}
