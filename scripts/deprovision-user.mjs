#!/usr/bin/env node
/**
 * Deprovision a user via the Cloudflare API (admin / wrangler token).
 * Does not need Cloudflare Access login or DEPROVISION_SECRET.
 *
 * Removes: Access sessions, Zero Trust seat (Inactive), Access group/policy
 * email rules, tunnel MyHomeGames-<username>, DNS CNAMEs (API + Moonlight).
 * Cloudflare keeps Inactive rows under Team & Resources → Users.
 *
 * Usage:
 *   # put MYGAMES_CF_API_TOKEN in myhomegames-proxy/.env (gitignored), then:
 *   npm run deprovision-user -- user@example.com
 *
 *   # or inline / shell:
 *   MYGAMES_CF_API_TOKEN=... npm run deprovision-user -- user@example.com
 *
 * Optional in .env:
 *   MYGAMES_ACCOUNT_ID=...  (defaults from wrangler.toml)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(join(ROOT, ".env"));
loadEnvFile(join(ROOT, ".env.local"));

const USER_TUNNEL_HOST_SUFFIX = "-myhomegames-server.vige.it";
const USER_MOONLIGHT_HOST_SUFFIX = "-moonlight-web.vige.it";
const ZONE_ID = "243802546c0a2d88201fe78091fa3e84";
const DEFAULT_ACCOUNT_ID = "d2633016ba82b226e5596563e44ced6d";

const email = String(process.argv[2] || "").trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("Usage: npm run deprovision-user -- user@example.com");
  process.exit(1);
}

const token = String(
  process.env.MYGAMES_CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "",
).trim();
const accountId = String(
  process.env.MYGAMES_ACCOUNT_ID || readAccountIdFromWrangler() || DEFAULT_ACCOUNT_ID,
).trim();

if (!token) {
  console.error(`Missing API token.

Add to myhomegames-proxy/.env (gitignored):

  MYGAMES_CF_API_TOKEN=...

Same token as the Worker secret MYGAMES_CF_API_TOKEN.
Needs Tunnel + DNS edit, Access Users/Groups/Apps write, and Zero Trust: Seats Write.

Then:
  npm run deprovision-user -- ${email}
`);
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
const accountApi = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const username = usernameFromEmail(email);
const tunnelName = `MyHomeGames-${username}`;
const apiHostname = `${username}${USER_TUNNEL_HOST_SUFFIX}`;
const moonlightHostname = `${username}${USER_MOONLIGHT_HOST_SUFFIX}`;

console.log(`Deprovisioning ${email}`);
console.log(`  username: ${username}`);
console.log(`  tunnel:   ${tunnelName}`);
console.log(`  dns:      ${apiHostname}, ${moonlightHostname}`);

const access = await deleteAccessIdentity(accountApi, headers, email);
const dns = {
  api: await deleteDnsCname(ZONE_ID, headers, apiHostname),
  moonlight: await deleteDnsCname(ZONE_ID, headers, moonlightHostname),
};
const tunnels = await deleteTunnels(accountApi, headers, tunnelName);

const result = {
  ok:
    access.ok &&
    (dns.api.deleted || dns.api.reason === "not_found") &&
    (dns.moonlight.deleted || dns.moonlight.reason === "not_found") &&
    (tunnels.length === 0 || tunnels.every((t) => t.deleted)),
  email,
  username,
  tunnelName,
  access,
  dns,
  tunnels,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Do not override variables already set in the shell.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readAccountIdFromWrangler() {
  try {
    const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
    const match = toml.match(/MYGAMES_ACCOUNT_ID\s*=\s*"([^"]+)"/);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function slugEmailPart(part) {
  return String(part || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function usernameFromEmail(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return slugEmailPart(normalized);
  const local = slugEmailPart(normalized.slice(0, at));
  const domain = slugEmailPart(normalized.slice(at + 1));
  if (!local) return domain;
  if (!domain) return local;
  return `${local}-${domain}`;
}

async function cfJson(url, init) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function listAccessUsersByEmail(accountApi, headers, userEmail) {
  const byEmail = await cfJson(
    `${accountApi}/access/users?email=${encodeURIComponent(userEmail)}&per_page=100`,
    { headers },
  );
  let users = Array.isArray(byEmail.data?.result) ? byEmail.data.result : [];
  let status = byEmail.res.status;
  let errors = byEmail.data?.errors || null;
  let ok = Boolean(byEmail.data?.success) || byEmail.res.status === 200;

  if (users.length === 0 && ok) {
    const search = await cfJson(
      `${accountApi}/access/users?search=${encodeURIComponent(userEmail)}&per_page=100`,
      { headers },
    );
    status = search.res.status;
    errors = search.data?.errors || null;
    ok = Boolean(search.data?.success) || search.res.status === 200;
    users = (Array.isArray(search.data?.result) ? search.data.result : []).filter(
      (u) => String(u?.email || "").toLowerCase() === userEmail,
    );
  }

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

async function deactivateZeroTrustSeat(accountApi, headers, seatUid, userEmail) {
  const patch = await cfJson(`${accountApi}/access/seats`, {
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
  return {
    seat_uid: seatUid,
    email: userEmail || null,
    ok: Boolean(patch.data?.success) || patch.res.status === 200,
    status: patch.res.status,
    errors: patch.data?.errors || null,
    result: Array.isArray(patch.data?.result) ? patch.data.result : null,
  };
}

async function deleteAccessIdentity(accountApi, headers, userEmail) {
  const revoke = await cfJson(`${accountApi}/access/organizations/revoke_user`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: userEmail, devices: true }),
  });

  const listed = await listAccessUsersByEmail(accountApi, headers, userEmail);
  const seats = [];
  const deletedUsers = [];

  for (const user of listed.users) {
    const userId = user?.id || user?.uid;
    const seatUid = user?.seat_uid || userId || null;
    if (seatUid) {
      seats.push(await deactivateZeroTrustSeat(accountApi, headers, seatUid, user.email || userEmail));
    }
    if (!userId) continue;
    const del = await cfJson(`${accountApi}/access/users/${userId}`, {
      method: "DELETE",
      headers,
    });
    deletedUsers.push({
      id: userId,
      email: user.email || userEmail,
      seat_uid: user.seat_uid || null,
      deleted: Boolean(del.data?.success) || del.res.status === 200 || del.res.status === 404,
      status: del.res.status,
      errors: del.data?.errors || null,
    });
  }

  const groups = await stripEmailFromAccessGroups(accountApi, headers, userEmail);
  const policies = await stripEmailFromAccessPolicies(accountApi, headers, userEmail);
  const seatsOk = seats.length === 0 || seats.every((s) => s.ok);
  const usersOk =
    deletedUsers.length === 0 || deletedUsers.every((u) => u.deleted);

  return {
    revoke: {
      ok:
        Boolean(revoke.data?.success) ||
        revoke.res.status === 200 ||
        revoke.res.status === 404,
      status: revoke.res.status,
      errors: revoke.data?.errors || null,
    },
    list: { ok: listed.ok, status: listed.status, errors: listed.errors },
    seats,
    users: deletedUsers,
    userFound: listed.users.length > 0,
    groups,
    policies,
    ok:
      (Boolean(revoke.data?.success) ||
        revoke.res.status === 200 ||
        revoke.res.status === 404) &&
      listed.ok &&
      seatsOk &&
      usersOk &&
      groups.every((g) => g.ok || g.skipped) &&
      policies.every((p) => p.ok || p.skipped),
    note:
      listed.users.length === 0
        ? listed.ok
          ? "No Access user record found (may already be inactive). Cloudflare keeps Inactive rows under Team & Resources → Users."
          : "Failed to list Access users — check API token permissions."
        : "Seat deactivated (Inactive). Cloudflare does not erase Team & Resources → Users rows; IdP accounts are not deleted.",
  };
}

function ruleMatchesEmail(rule, userEmail) {
  if (!rule || typeof rule !== "object") return false;
  const direct = rule.email;
  if (typeof direct === "string") return direct.toLowerCase() === userEmail;
  if (direct && typeof direct === "object" && typeof direct.email === "string") {
    return direct.email.toLowerCase() === userEmail;
  }
  return false;
}

function stripEmailFromRuleList(rules, userEmail) {
  if (!Array.isArray(rules)) return { rules: rules || [], changed: false };
  const next = rules.filter((rule) => !ruleMatchesEmail(rule, userEmail));
  return { rules: next, changed: next.length !== rules.length };
}

async function stripEmailFromAccessGroups(accountApi, headers, userEmail) {
  const list = await cfJson(`${accountApi}/access/groups?per_page=100`, { headers });
  const groups = Array.isArray(list.data?.result) ? list.data.result : [];
  const updates = [];
  for (const group of groups) {
    const groupId = group?.id;
    if (!groupId) continue;
    const include = stripEmailFromRuleList(group.include, userEmail);
    const exclude = stripEmailFromRuleList(group.exclude, userEmail);
    const require = stripEmailFromRuleList(group.require, userEmail);
    if (!include.changed && !exclude.changed && !require.changed) continue;
    if (include.changed && include.rules.length === 0) {
      updates.push({
        id: groupId,
        name: group.name || null,
        ok: false,
        skipped: "would_empty_include",
      });
      continue;
    }
    const put = await cfJson(`${accountApi}/access/groups/${groupId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: group.name,
        include: include.rules,
        exclude: exclude.rules,
        require: require.rules,
      }),
    });
    updates.push({
      id: groupId,
      name: group.name || null,
      ok: Boolean(put.data?.success) || put.res.status === 200,
      status: put.res.status,
      errors: put.data?.errors || null,
    });
  }
  return updates;
}

async function stripEmailFromAccessPolicies(accountApi, headers, userEmail) {
  const appsList = await cfJson(`${accountApi}/access/apps?per_page=100`, { headers });
  const apps = Array.isArray(appsList.data?.result) ? appsList.data.result : [];
  const updates = [];
  for (const app of apps) {
    const appId = app?.id;
    if (!appId) continue;
    const policiesList = await cfJson(
      `${accountApi}/access/apps/${appId}/policies?per_page=100`,
      { headers },
    );
    const policies = Array.isArray(policiesList.data?.result) ? policiesList.data.result : [];
    for (const policy of policies) {
      const policyId = policy?.id;
      if (!policyId) continue;
      const include = stripEmailFromRuleList(policy.include, userEmail);
      const exclude = stripEmailFromRuleList(policy.exclude, userEmail);
      const require = stripEmailFromRuleList(policy.require, userEmail);
      if (!include.changed && !exclude.changed && !require.changed) continue;
      if (include.changed && include.rules.length === 0) {
        updates.push({
          app_id: appId,
          policy_id: policyId,
          ok: false,
          skipped: "would_empty_include",
        });
        continue;
      }
      const put = await cfJson(`${accountApi}/access/apps/${appId}/policies/${policyId}`, {
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
      updates.push({
        app_id: appId,
        app_name: app.name || null,
        policy_id: policyId,
        policy_name: policy.name || null,
        ok: Boolean(put.data?.success) || put.res.status === 200,
        status: put.res.status,
        errors: put.data?.errors || null,
      });
    }
  }
  return updates;
}

async function findDnsCname(zoneId, headers, name) {
  const list = await cfJson(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
    { headers },
  );
  return (
    list.data?.result?.find((r) => r.name === name || r.name === `${name}.`) || null
  );
}

async function deleteDnsCname(zoneId, headers, name) {
  const existing = await findDnsCname(zoneId, headers, name);
  if (!existing) return { name, deleted: false, reason: "not_found" };
  const del = await cfJson(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${existing.id}`,
    { method: "DELETE", headers },
  );
  return {
    name,
    id: existing.id,
    deleted: Boolean(del.data?.success) || del.res.status === 200 || del.res.status === 404,
    status: del.res.status,
    errors: del.data?.errors || null,
  };
}

async function deleteTunnels(accountApi, headers, name) {
  const list = await cfJson(
    `${accountApi}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
    { headers },
  );
  const tunnels = Array.isArray(list.data?.result) ? list.data.result : [];
  const out = [];
  for (const tunnel of tunnels) {
    const tunnelId = tunnel?.id;
    if (!tunnelId) continue;
    const del = await cfJson(`${accountApi}/cfd_tunnel/${tunnelId}`, {
      method: "DELETE",
      headers,
    });
    out.push({
      id: tunnelId,
      name: tunnel.name || name,
      deleted: Boolean(del.data?.success) || del.res.status === 200 || del.res.status === 404,
      status: del.res.status,
      errors: del.data?.errors || null,
    });
  }
  return out;
}
