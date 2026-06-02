const TWITCH_ID_HEADER = "X-Twitch-Client-Id";
const TWITCH_SECRET_HEADER = "X-Twitch-Client-Secret";
const AUTH_TWITCH_PATH = "/auth/twitch";

function originBase(env, hostname) {
  // NUOVO: se l'hostname è un sottodominio del tunnel dinamico,
  // usa quello come target (es. luca.myhomegames-server.vige.it)
  if (hostname && hostname.endsWith(".myhomegames-server.vige.it")) {
    return `http://${hostname}:4000`;
  }
  // Fallback per sviluppo locale
  const host = (env.ORIGIN_HTTP_HOST || "127.0.0.1").trim();
  const port = (env.ORIGIN_HTTP_PORT || "4000").trim();
  return `http://${host}:${port}`;
}

function injectTwitchHeaders(headers, env) {
  headers.delete(TWITCH_ID_HEADER);
  headers.delete(TWITCH_SECRET_HEADER);
  if (env.TWITCH_CLIENT_ID) headers.set(TWITCH_ID_HEADER, env.TWITCH_CLIENT_ID);
  if (env.TWITCH_CLIENT_SECRET) headers.set(TWITCH_SECRET_HEADER, env.TWITCH_CLIENT_SECRET);
}

async function buildForwardRequest(request, env) {
  const incoming = new URL(request.url);
  const hostname = request.headers.get("Host") || incoming.hostname;  // NUOVO
  const target = new URL(incoming.pathname + incoming.search, originBase(env, hostname));
  const headers = new Headers(request.headers);
  injectTwitchHeaders(headers, env);
  let body = request.body;
  if (request.method === "POST" && incoming.pathname === AUTH_TWITCH_PATH) {
    const ct = request.headers.get("Content-Type") || "";
    if (ct.includes("application/json")) {
      const raw = await request.text();
      let json = {};
      try {
        json = raw ? JSON.parse(raw) : {};
      } catch {
        return { errorResponse: new Response("Invalid JSON", { status: 400 }) };
      }
      if (!json.clientId && env.TWITCH_CLIENT_ID) json.clientId = env.TWITCH_CLIENT_ID;
      if (!json.clientSecret && env.TWITCH_CLIENT_SECRET) json.clientSecret = env.TWITCH_CLIENT_SECRET;
      body = JSON.stringify(json);
      headers.set("Content-Type", "application/json");
    }
  }
  return {
    forwarded: new Request(target.toString(), {
      method: request.method,
      headers,
      body: body ?? undefined,
      redirect: "manual",
    }),
  };
}

export default {
  async fetch(request, env) {
    // RIMOSSO: check su env.BACKEND
    if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
      return new Response("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET secrets are missing", {
        status: 500,
      });
    }
    const built = await buildForwardRequest(request, env);
    if (built.errorResponse) return built.errorResponse;
    return fetch(built.forwarded);  // CAMBIATO: da env.BACKEND.fetch() a fetch()
  },
};
