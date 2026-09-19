import { ZONE_ID } from "./config.js";
import { emailFromAccessJwt } from "./access-auth.js";
import { deleteDnsCname } from "./dns.js";
import { userTunnelHostname, userMoonlightWebHostname, usernameFromEmail } from "./hostnames.js";
import { escapeHtml, htmlPage, jsonWithCors, timingSafeEqual } from "./http.js";

/**
 * Remove Cloudflare Tunnel + per-user DNS + Zero Trust / Access identity.
 */
export async function deprovisionUserResources(env, email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const username = usernameFromEmail(normalizedEmail);
  if (!username) {
    return { error: "invalid_email", email };
  }

  const tunnelName = "MyHomeGames-" + username;
  const apiHostname = userTunnelHostname(username);
  const moonlightHostname = userMoonlightWebHostname(username);
  const accountApi = "https://api.cloudflare.com/client/v4/accounts/" + env.MYGAMES_ACCOUNT_ID;
  const headers = {
    Authorization: "Bearer " + env.MYGAMES_CF_API_TOKEN,
    "Content-Type": "application/json",
  };

  const access = await deleteAccessIdentity(accountApi, headers, normalizedEmail);

  const dns = {
    api: await deleteDnsCname(ZONE_ID, headers, apiHostname),
    moonlight: await deleteDnsCname(ZONE_ID, headers, moonlightHostname),
  };

  const listResp = await fetch(
    accountApi + "/cfd_tunnel?name=" + encodeURIComponent(tunnelName) + "&is_deleted=false",
    { headers },
  );
  const listData = await listResp.json();
  const tunnels = Array.isArray(listData?.result) ? listData.result : [];
  const tunnelDeletes = [];

  for (const tunnel of tunnels) {
    const tunnelId = tunnel?.id;
    if (!tunnelId) continue;
    const delResp = await fetch(accountApi + "/cfd_tunnel/" + tunnelId, {
      method: "DELETE",
      headers,
    });
    const delData = await delResp.json().catch(() => ({}));
    tunnelDeletes.push({
      id: tunnelId,
      name: tunnel.name || tunnelName,
      deleted: Boolean(delData?.success) || delResp.status === 200 || delResp.status === 404,
      status: delResp.status,
      errors: delData?.errors || null,
    });
  }

  return {
    email: normalizedEmail,
    username,
    tunnelName,
    hostnames: { api: apiHostname, moonlight: moonlightHostname },
    access,
    dns,
    tunnels: tunnelDeletes,
    tunnelFound: tunnels.length > 0,
  };
}

/**
 * Revoke Access sessions, deactivate Zero Trust seats (dashboard "Remove users"),
 * best-effort DELETE Access user, and strip email from Access Groups / policies.
 *
 * Cloudflare cannot fully erase Team & Resources → Users rows: after seat removal
 * the user stays listed as Inactive. See seat-management docs.
 */
export async function deleteAccessIdentity(accountApi, headers, email) {
  const revokeResp = await fetch(accountApi + "/access/organizations/revoke_user", {
    method: "POST",
    headers,
    body: JSON.stringify({ email, devices: true }),
  });
  const revokeData = await revokeResp.json().catch(() => ({}));
  const revoke = {
    ok: Boolean(revokeData?.success) || revokeResp.status === 200 || revokeResp.status === 404,
    status: revokeResp.status,
    errors: revokeData?.errors || null,
  };

  const listed = await listAccessUsersByEmail(accountApi, headers, email);
  const seats = [];
  const deletedUsers = [];

  for (const user of listed.users) {
    const userId = user?.id || user?.uid;
    const seatUid = user?.seat_uid || userId || null;
    if (seatUid) {
      seats.push(await deactivateZeroTrustSeat(accountApi, headers, seatUid, user.email || email));
    }
    if (!userId) continue;
    const delResp = await fetch(accountApi + "/access/users/" + userId, {
      method: "DELETE",
      headers,
    });
    const delData = await delResp.json().catch(() => ({}));
    deletedUsers.push({
      id: userId,
      email: user.email || email,
      seat_uid: user.seat_uid || null,
      deleted: Boolean(delData?.success) || delResp.status === 200 || delResp.status === 404,
      status: delResp.status,
      errors: delData?.errors || null,
    });
  }

  const groups = await stripEmailFromAccessGroups(accountApi, headers, email);
  const policies = await stripEmailFromAccessPolicies(accountApi, headers, email);

  const seatsOk = seats.length === 0 || seats.every((s) => s.ok);
  const usersOk =
    deletedUsers.length === 0 || deletedUsers.every((u) => u.deleted);
  const groupsOk = groups.every((g) => g.ok || g.skipped);
  const policiesOk = policies.every((p) => p.ok || p.skipped);
  const listOk = listed.ok;

  return {
    revoke,
    list: { ok: listOk, status: listed.status, errors: listed.errors },
    seats,
    users: deletedUsers,
    userFound: listed.users.length > 0,
    groups,
    policies,
    ok: revoke.ok && listOk && seatsOk && usersOk && groupsOk && policiesOk,
    note:
      listed.users.length === 0
        ? listOk
          ? "No Access user record found for this email (may already be inactive). Sessions revoked; groups/policies updated when applicable. Cloudflare keeps Inactive rows under Team & Resources → Users."
          : "Failed to list Access users — check API token permissions (Access: Audit Logs Read / Users)."
        : "Seat deactivated (Inactive) and sessions revoked. Cloudflare does not erase Team & Resources → Users rows; IdP accounts (e.g. Google) are not deleted.",
  };
}

/** List Access / Zero Trust users matching an email (email filter, then search). */
export async function listAccessUsersByEmail(accountApi, headers, email) {
  const byEmailResp = await fetch(
    accountApi + "/access/users?email=" + encodeURIComponent(email) + "&per_page=100",
    { headers },
  );
  const byEmailData = await byEmailResp.json().catch(() => ({}));
  let users = Array.isArray(byEmailData?.result) ? byEmailData.result : [];
  let status = byEmailResp.status;
  let errors = byEmailData?.errors || null;
  let ok = Boolean(byEmailData?.success) || byEmailResp.status === 200;

  if (users.length === 0 && ok) {
    const searchResp = await fetch(
      accountApi + "/access/users?search=" + encodeURIComponent(email) + "&per_page=100",
      { headers },
    );
    const searchData = await searchResp.json().catch(() => ({}));
    status = searchResp.status;
    errors = searchData?.errors || null;
    ok = Boolean(searchData?.success) || searchResp.status === 200;
    users = (Array.isArray(searchData?.result) ? searchData.result : []).filter(
      (u) => String(u?.email || "").toLowerCase() === email,
    );
  }

  // Deduplicate by id/uid.
  const seen = new Set();
  users = users.filter((u) => {
    const id = u?.id || u?.uid;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return { ok, status, errors, users };
}

/**
 * Same action as Zero Trust dashboard → Users → Action → Remove users:
 * PATCH /access/seats with access_seat + gateway_seat false.
 * Requires token permission: Zero Trust: Seats Write.
 */
export async function deactivateZeroTrustSeat(accountApi, headers, seatUid, email) {
  const resp = await fetch(accountApi + "/access/seats", {
    method: "PATCH",
    headers,
    body: JSON.stringify([
      {
        seat_uid: seatUid,
        access_seat: false,
        gateway_seat: false,
      },
    ]),
  });
  const data = await resp.json().catch(() => ({}));
  return {
    seat_uid: seatUid,
    email: email || null,
    ok: Boolean(data?.success) || resp.status === 200,
    status: resp.status,
    errors: data?.errors || null,
    result: Array.isArray(data?.result) ? data.result : null,
  };
}

export function ruleMatchesEmail(rule, email) {
  if (!rule || typeof rule !== "object") return false;
  const direct = rule.email;
  if (typeof direct === "string") return direct.toLowerCase() === email;
  if (direct && typeof direct === "object" && typeof direct.email === "string") {
    return direct.email.toLowerCase() === email;
  }
  return false;
}

export function stripEmailFromRuleList(rules, email) {
  if (!Array.isArray(rules)) return { rules: rules || [], changed: false };
  const next = rules.filter((rule) => !ruleMatchesEmail(rule, email));
  return { rules: next, changed: next.length !== rules.length };
}

export async function stripEmailFromAccessGroups(accountApi, headers, email) {
  const listResp = await fetch(accountApi + "/access/groups?per_page=100", { headers });
  const listData = await listResp.json().catch(() => ({}));
  const groups = Array.isArray(listData?.result) ? listData.result : [];
  const updates = [];

  for (const group of groups) {
    const groupId = group?.id;
    if (!groupId) continue;
    const include = stripEmailFromRuleList(group.include, email);
    const exclude = stripEmailFromRuleList(group.exclude, email);
    const require = stripEmailFromRuleList(group.require, email);
    if (!include.changed && !exclude.changed && !require.changed) continue;

    if (include.changed && include.rules.length === 0) {
      updates.push({
        id: groupId,
        name: group.name || null,
        ok: false,
        skipped: "would_empty_include",
        detail: "Refusing to update Access Group with an empty include list; remove the group manually if needed.",
      });
      continue;
    }

    const putResp = await fetch(accountApi + "/access/groups/" + groupId, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: group.name,
        include: include.rules,
        exclude: exclude.rules,
        require: require.rules,
      }),
    });
    const putData = await putResp.json().catch(() => ({}));
    updates.push({
      id: groupId,
      name: group.name || null,
      ok: Boolean(putData?.success) || putResp.status === 200,
      status: putResp.status,
      errors: putData?.errors || null,
    });
  }

  return updates;
}

export async function stripEmailFromAccessPolicies(accountApi, headers, email) {
  const appsResp = await fetch(accountApi + "/access/apps?per_page=100", { headers });
  const appsData = await appsResp.json().catch(() => ({}));
  const apps = Array.isArray(appsData?.result) ? appsData.result : [];
  const updates = [];

  for (const app of apps) {
    const appId = app?.id;
    if (!appId) continue;
    const policiesResp = await fetch(accountApi + "/access/apps/" + appId + "/policies?per_page=100", {
      headers,
    });
    const policiesData = await policiesResp.json().catch(() => ({}));
    const policies = Array.isArray(policiesData?.result) ? policiesData.result : [];

    for (const policy of policies) {
      const policyId = policy?.id;
      if (!policyId) continue;
      const include = stripEmailFromRuleList(policy.include, email);
      const exclude = stripEmailFromRuleList(policy.exclude, email);
      const require = stripEmailFromRuleList(policy.require, email);
      if (!include.changed && !exclude.changed && !require.changed) continue;

      if (include.changed && include.rules.length === 0) {
        updates.push({
          app_id: appId,
          app_name: app.name || null,
          policy_id: policyId,
          policy_name: policy.name || null,
          ok: false,
          skipped: "would_empty_include",
          detail: "Refusing to update Access policy with an empty include list; edit the policy manually if needed.",
        });
        continue;
      }

      const putResp = await fetch(accountApi + "/access/apps/" + appId + "/policies/" + policyId, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          name: policy.name,
          decision: policy.decision,
          include: include.rules,
          exclude: exclude.rules,
          require: require.rules,
          precedence: policy.precedence,
          purpose_justification_required: policy.purpose_justification_required,
          purpose_justification_prompt: policy.purpose_justification_prompt,
          approval_required: policy.approval_required,
          session_duration: policy.session_duration,
        }),
      });
      const putData = await putResp.json().catch(() => ({}));
      updates.push({
        app_id: appId,
        app_name: app.name || null,
        policy_id: policyId,
        policy_name: policy.name || null,
        ok: Boolean(putData?.success) || putResp.status === 200,
        status: putResp.status,
        errors: putData?.errors || null,
      });
    }
  }

  return updates;
}




/**
 * Admin deprovision: delete Access identity + tunnel + DNS for a user email.
 * Auth (either):
 * - Cloudflare Access JWT (browser session — preferred)
 * - Optional header `X-MHG-Deprovision-Secret` when `DEPROVISION_SECRET` is set (scripts)
 * - Optional `DEPROVISION_ADMIN_EMAILS`: if set, Access callers must be in that list
 *
 * Body JSON: `{ "email": "user@example.com" }`
 */
export async function handleDeprovisionUser(request, env) {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return jsonWithCors(request, { error: "Method not allowed" }, 405, {
      methods: "POST, DELETE, OPTIONS",
    });
  }

  const auth = authorizeDeprovision(request, env);
  if (auth.error) {
    return jsonWithCors(request, { error: auth.error, detail: auth.detail }, auth.status, {
      methods: "POST, DELETE, OPTIONS",
    });
  }

  let email = "";
  try {
    if (request.method === "POST") {
      const body = await request.json();
      email = String(body?.email || "").trim();
    }
  } catch {
    email = "";
  }
  if (!email) {
    const url = new URL(request.url);
    email = String(url.searchParams.get("email") || "").trim();
  }
  if (!email || !email.includes("@")) {
    return jsonWithCors(
      request,
      { error: "email_required", detail: "Pass JSON { \"email\": \"...\" } or ?email=" },
      400,
      { methods: "POST, DELETE, OPTIONS" },
    );
  }

  if (!env.MYGAMES_CF_API_TOKEN || !env.MYGAMES_ACCOUNT_ID) {
    return jsonWithCors(
      request,
      { error: "api_token_missing", detail: "MYGAMES_CF_API_TOKEN / MYGAMES_ACCOUNT_ID required" },
      500,
      { methods: "POST, DELETE, OPTIONS" },
    );
  }

  const result = await deprovisionUserResources(env, email);
  if (result.error) {
    return jsonWithCors(request, result, 400, { methods: "POST, DELETE, OPTIONS" });
  }

  const dnsOk = result.dns.api.deleted || result.dns.api.reason === "not_found";
  const dnsMoonOk =
    result.dns.moonlight.deleted || result.dns.moonlight.reason === "not_found";
  const tunnelsOk =
    !result.tunnelFound || result.tunnels.every((t) => t.deleted);
  const accessOk = result.access?.ok !== false;
  const ok = dnsOk && dnsMoonOk && tunnelsOk && accessOk;

  return jsonWithCors(
    request,
    {
      ok,
      ...result,
      authorizedBy: auth.via,
    },
    ok ? 200 : 502,
    { methods: "POST, DELETE, OPTIONS" },
  );
}

export function authorizeDeprovision(request, env) {
  const configuredSecret = String(env.DEPROVISION_SECRET || "").trim();
  const providedSecret = String(
    request.headers.get("X-MHG-Deprovision-Secret") ||
      request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ||
      "",
  ).trim();

  if (configuredSecret && providedSecret && timingSafeEqual(configuredSecret, providedSecret)) {
    return { via: "secret" };
  }

  const identity = emailFromAccessJwt(request);
  if (!identity.error) {
    const adminEmails = String(env.DEPROVISION_ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const caller = String(identity.email).toLowerCase();
    if (adminEmails.length > 0 && !adminEmails.includes(caller)) {
      return {
        error: "forbidden",
        detail: "Caller is not in DEPROVISION_ADMIN_EMAILS",
        status: 403,
      };
    }
    return { via: "access", admin: identity.email };
  }

  if (configuredSecret) {
    return {
      error: "unauthorized",
      detail: "Sign in with Cloudflare Access, or pass X-MHG-Deprovision-Secret",
      status: 401,
    };
  }

  return {
    error: "not_authenticated",
    detail: "Cloudflare Access login required (open /deprovision in the browser while signed in)",
    status: 401,
  };
}

export function handleDeprovisionPage(request) {
  if (request.method !== "GET") {
    return htmlPage("Method not allowed", "<p>Use GET.</p>", 405);
  }

  const identity = emailFromAccessJwt(request);
  const signedIn = !identity.error
    ? `<p>Signed in as <strong>${escapeHtml(identity.email)}</strong>.</p>`
    : `<p>Cloudflare Access authentication is required. Sign in first, then reopen this page.</p>
       <p><a href="/api/get-token">Sign in with Cloudflare Access</a></p>`;
  const urlEmail = String(new URL(request.url).searchParams.get("email") || "").trim();
  const prefillEmail = escapeHtml(urlEmail);

  const body = `${signedIn}
    <p>Revoke Access sessions, deactivate the Zero Trust seat (Inactive), remove email from groups/policies when listed, and delete tunnel + DNS. Cloudflare keeps Inactive rows under Team &amp; Resources → Users.</p>
    <form id="deprovision-form">
      <label for="email">User email</label>
      <input id="email" name="email" type="email" required autocomplete="off" value="${prefillEmail}"
        style="width:100%;margin:.5rem 0 1rem;padding:.6rem .75rem;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#111;color:#fff;" />
      <button type="submit"
        style="width:100%;padding:.7rem 1rem;border:0;border-radius:8px;background:#e5a00d;color:#111;font-weight:600;cursor:pointer;">
        Deprovision
      </button>
    </form>
    <pre id="result" style="margin-top:1rem;white-space:pre-wrap;word-break:break-word;color:rgba(255,255,255,.7);font-size:.85rem;"></pre>
    <script>
      (function () {
        var input = document.getElementById("email");
        var params = new URLSearchParams(window.location.search);
        var fromQuery = (params.get("email") || "").trim();
        if (fromQuery) {
          input.value = fromQuery;
        }
        document.getElementById("deprovision-form").addEventListener("submit", async function (e) {
          e.preventDefault();
          var email = input.value.trim();
          var out = document.getElementById("result");
          out.textContent = "Working…";
          try {
            var res = await fetch("/api/deprovision-user", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: email })
            });
            var text = await res.text();
            try { out.textContent = JSON.stringify(JSON.parse(text), null, 2); }
            catch { out.textContent = text; }
          } catch (err) {
            out.textContent = String(err && err.message ? err.message : err);
          }
        });
      })();
    </script>`;

  return htmlPage("Deprovision user", body);
}
