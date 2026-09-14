import {
  MANAGER_HOST,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  USER_CODE_ALPHABET,
} from "./config.js";
import { emailFromAccessJwt } from "./access-auth.js";
import { escapeHtml, htmlPage, jsonWithCors } from "./http.js";
import { mintTunnelForEmail } from "./tunnel.js";

function pairingKv(env) {
  return env.DEVICE_PAIRING || null;
}

function deviceKey(deviceCode) {
  return `device:${deviceCode}`;
}

function userKey(userCode) {
  return `user:${normalizeUserCode(userCode)}`;
}

function normalizeUserCode(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function formatUserCode(normalized) {
  const clean = normalizeUserCode(normalized);
  if (clean.length !== 8) return clean;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

function randomUserCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  }
  return formatUserCode(out);
}

function randomDeviceCode() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function putPairingSession(kv, session) {
  const ttl = Math.max(60, Math.floor((session.expires_at - Date.now()) / 1000));
  const body = JSON.stringify(session);
  await kv.put(deviceKey(session.device_code), body, { expirationTtl: ttl });
  await kv.put(userKey(session.user_code), session.device_code, { expirationTtl: ttl });
}

async function readPairingByDevice(kv, deviceCode) {
  const raw = await kv.get(deviceKey(deviceCode));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readPairingByUserCode(kv, userCode) {
  const deviceCode = await kv.get(userKey(userCode));
  if (!deviceCode) return null;
  return readPairingByDevice(kv, deviceCode);
}

async function deletePairingSession(kv, session) {
  await Promise.all([
    kv.delete(deviceKey(session.device_code)),
    kv.delete(userKey(session.user_code)),
  ]);
}

export async function handleDeviceCode(request, env) {
  if (request.method !== "POST") {
    return jsonWithCors(request, { error: "Method not allowed" }, 405, { methods: "POST, OPTIONS" });
  }

  const kv = pairingKv(env);
  if (!kv) {
    return jsonWithCors(
      request,
      {
        error: "Device pairing is not configured",
        detail: "Bind a KV namespace as DEVICE_PAIRING on the tunnel manager Worker.",
      },
      503,
      { methods: "POST, OPTIONS" },
    );
  }

  let userCode = randomUserCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await kv.get(userKey(userCode));
    if (!existing) break;
    userCode = randomUserCode();
  }

  const deviceCode = randomDeviceCode();
  const expiresAt = Date.now() + DEVICE_CODE_TTL_SECONDS * 1000;
  const verificationUri = `https://${MANAGER_HOST}/link`;
  const verificationUriComplete = `${verificationUri}?code=${encodeURIComponent(normalizeUserCode(userCode))}`;

  const session = {
    device_code: deviceCode,
    user_code: normalizeUserCode(userCode),
    status: "pending",
    expires_at: expiresAt,
    created_at: Date.now(),
  };
  await putPairingSession(kv, session);

  return jsonWithCors(
    request,
    {
      device_code: deviceCode,
      user_code: formatUserCode(userCode),
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    },
    200,
    { methods: "POST, OPTIONS" },
  );
}

export async function handleDevicePoll(request, env) {
  if (request.method !== "GET") {
    return jsonWithCors(request, { error: "Method not allowed" }, 405, { methods: "GET, OPTIONS" });
  }

  const kv = pairingKv(env);
  if (!kv) {
    return jsonWithCors(
      request,
      { error: "Device pairing is not configured" },
      503,
      { methods: "GET, OPTIONS" },
    );
  }

  const deviceCode = new URL(request.url).searchParams.get("device_code")?.trim() || "";
  if (!deviceCode || deviceCode.length < 16) {
    return jsonWithCors(request, { error: "invalid_device_code" }, 400, { methods: "GET, OPTIONS" });
  }

  const session = await readPairingByDevice(kv, deviceCode);
  if (!session) {
    return jsonWithCors(request, { status: "expired" }, 200, { methods: "GET, OPTIONS" });
  }
  if (session.expires_at && Date.now() > session.expires_at) {
    await deletePairingSession(kv, session);
    return jsonWithCors(request, { status: "expired" }, 200, { methods: "GET, OPTIONS" });
  }
  if (session.status === "pending") {
    return jsonWithCors(request, { status: "authorization_pending" }, 200, { methods: "GET, OPTIONS" });
  }
  if (session.status === "ok" && session.token && session.url) {
    const payload = { status: "ok", token: session.token, url: session.url };
    await deletePairingSession(kv, session);
    return jsonWithCors(request, payload, 200, { methods: "GET, OPTIONS" });
  }

  return jsonWithCors(request, { status: "expired" }, 200, { methods: "GET, OPTIONS" });
}

export async function handleDeviceApprove(request, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return htmlPage("Method not allowed", "<p>Use GET or POST.</p>", 405);
  }

  const kv = pairingKv(env);
  if (!kv) {
    return htmlPage(
      "Pairing unavailable",
      "<p>Device pairing KV is not configured on the tunnel manager.</p>",
      503,
    );
  }

  const identity = emailFromAccessJwt(request);
  if (identity.error) {
    return htmlPage(
      "Sign in required",
      "<p>Cloudflare Access authentication is required to link a TV.</p>",
      401,
    );
  }

  let userCode = "";
  if (request.method === "POST") {
    const contentType = request.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      try {
        const body = await request.json();
        userCode = String(body?.user_code || "");
      } catch {
        userCode = "";
      }
    } else {
      const form = await request.formData();
      userCode = String(form.get("user_code") || "");
    }
  } else {
    userCode = new URL(request.url).searchParams.get("user_code") || "";
  }

  const normalized = normalizeUserCode(userCode);
  if (normalized.length !== 8) {
    return htmlPage(
      "Invalid code",
      `<p>Enter the 8-character code shown on the TV.</p><p><a href="/link">Try again</a></p>`,
      400,
    );
  }

  const session = await readPairingByUserCode(kv, normalized);
  if (!session || (session.expires_at && Date.now() > session.expires_at)) {
    if (session) await deletePairingSession(kv, session);
    return htmlPage(
      "Code expired",
      `<p>That code is invalid or expired. Start again from the TV.</p><p><a href="/link">Try again</a></p>`,
      410,
    );
  }
  if (session.status === "ok") {
    return htmlPage(
      "Already linked",
      "<p>This code was already approved. Check the TV — it should connect shortly.</p>",
      200,
    );
  }

  const minted = await mintTunnelForEmail(env, identity.email);
  if (minted.error) {
    return htmlPage(
      "Tunnel error",
      `<p>Could not prepare your tunnel (${minted.error}).</p><p><a href="/link">Try again</a></p>`,
      502,
    );
  }

  const updated = {
    ...session,
    status: "ok",
    token: minted.token,
    url: minted.url,
    approved_email: identity.email,
    approved_at: Date.now(),
  };
  await putPairingSession(kv, updated);

  return htmlPage(
    "TV linked",
    `<p>Signed in as <strong>${escapeHtml(identity.email)}</strong>.</p>
     <p>Return to the TV — MyHomeGames should connect automatically.</p>`,
    200,
  );
}

export function handleLinkPage(request) {
  const url = new URL(request.url);
  const prefill = formatUserCode(url.searchParams.get("code") || "");
  const approveUrl = "/api/device/approve";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Link TV — MyHomeGames</title>
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
    h1 { margin: 0 0 .5rem; font-size: 1.5rem; }
    p { margin: 0 0 1.25rem; color: rgba(255,255,255,.7); line-height: 1.45; }
    label { display: block; font-size: .85rem; margin-bottom: .4rem; color: rgba(255,255,255,.8); }
    input {
      width: 100%; box-sizing: border-box; font-size: 1.5rem; letter-spacing: .2em;
      text-align: center; text-transform: uppercase; padding: .75rem;
      border-radius: 10px; border: 1px solid rgba(255,255,255,.2);
      background: #111; color: #fff; margin-bottom: 1rem;
    }
    button {
      width: 100%; padding: .85rem 1rem; border: 0; border-radius: 10px;
      background: #e5a00d; color: #111; font-weight: 700; font-size: 1rem; cursor: pointer;
    }
    button:hover { filter: brightness(1.05); }
  </style>
</head>
<body>
  <main>
    <h1>Link your TV</h1>
    <p>Enter the code shown on the Smart TV, then sign in with Cloudflare Access.</p>
    <form method="GET" action="${approveUrl}">
      <label for="user_code">TV code</label>
      <input id="user_code" name="user_code" maxlength="9" inputmode="text" autocomplete="one-time-code"
        spellcheck="false" value="${escapeHtml(prefill)}" placeholder="ABCD-EFGH" required />
      <button type="submit">Continue with Cloudflare</button>
    </form>
  </main>
  <script>
    (function () {
      var input = document.getElementById("user_code");
      if (!input) return;
      function formatCode(raw) {
        var clean = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
        if (clean.length <= 4) return clean;
        return clean.slice(0, 4) + "-" + clean.slice(4);
      }
      function applyFormat() {
        var start = input.selectionStart;
        var before = input.value;
        var next = formatCode(before);
        if (next === before) return;
        input.value = next;
        // Keep caret after the typed char; jump past auto-inserted hyphen.
        var pos = typeof start === "number" ? start : next.length;
        if (before.length < next.length && next.charAt(pos - 1) === "-") pos += 1;
        if (next.length >= 5 && before.length <= 4 && pos === 4) pos = 5;
        try { input.setSelectionRange(pos, pos); } catch (e) {}
      }
      input.addEventListener("input", applyFormat);
      input.addEventListener("blur", applyFormat);
      applyFormat();
    })();
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
