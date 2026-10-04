#!/usr/bin/env node
/**
 * List Zero Trust users and the matching Cloudflare Tunnel status.
 * Read-only. Uses the same API token as deprovision (myhomegames-proxy/.env).
 *
 * Usage:
 *   npm run list-users
 *   npm run list-users -- --json
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(join(ROOT, ".env"));
loadEnvFile(join(ROOT, ".env.local"));

const DEFAULT_ACCOUNT_ID = "d2633016ba82b226e5596563e44ced6d";
const TUNNEL_PREFIX = "MyHomeGames-";
const jsonOut = process.argv.includes("--json");

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

Same token as the Worker secret. Needs Access user read and Cloudflare Tunnel read.

Then:
  npm run list-users
`);
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
const accountApi = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

const users = await listAll(`${accountApi}/access/users`);
const tunnels = await listAll(`${accountApi}/cfd_tunnel?is_deleted=false`);

const tunnelsByName = new Map();
for (const tunnel of tunnels) {
  const name = String(tunnel?.name || "");
  if (!name) continue;
  const list = tunnelsByName.get(name) || [];
  list.push(tunnel);
  tunnelsByName.set(name, list);
}

const matchedTunnelIds = new Set();
const rows = users
  .map((user) => {
    const email = String(user?.email || "").trim().toLowerCase();
    const tunnelName = email ? `${TUNNEL_PREFIX}${usernameFromEmail(email)}` : "";
    const matches = tunnelName ? tunnelsByName.get(tunnelName) || [] : [];
    for (const tunnel of matches) {
      if (tunnel?.id) matchedTunnelIds.add(tunnel.id);
    }
    const tunnel = matches[0] || null;
    return {
      email: email || null,
      name: user?.name || null,
      seat: seatLabel(user),
      access_seat: Boolean(user?.access_seat),
      gateway_seat: Boolean(user?.gateway_seat),
      last_login: user?.last_successful_login || null,
      tunnel: tunnelName || null,
      tunnel_status: tunnel ? tunnelStatus(tunnel) : "none",
      tunnel_id: tunnel?.id || null,
      connections: connectionCount(tunnel),
    };
  })
  .sort((a, b) => String(a.email).localeCompare(String(b.email)));

const orphans = tunnels
  .filter((tunnel) => tunnel?.id && !matchedTunnelIds.has(tunnel.id) && String(tunnel?.name || "").startsWith(TUNNEL_PREFIX))
  .map((tunnel) => ({
    email: null,
    tunnel: tunnel.name,
    tunnel_status: tunnelStatus(tunnel),
    tunnel_id: tunnel.id,
    connections: connectionCount(tunnel),
  }));

if (jsonOut) {
  console.log(JSON.stringify({ users: rows, orphan_tunnels: orphans }, null, 2));
} else {
  const header = ["EMAIL", "SEAT", "LAST LOGIN", "TUNNEL", "STATUS", "CONNS"];
  const body = rows.map((row) => [
    row.email || "—",
    row.seat,
    formatWhen(row.last_login),
    row.tunnel || "—",
    row.tunnel_status,
    String(row.connections),
  ]);
  printTable(header, body);
  console.log("");
  console.log(`${rows.length} user${rows.length === 1 ? "" : "s"}`);
  const up = rows.filter((row) => row.tunnel_status === "healthy" || row.tunnel_status === "degraded").length;
  const down = rows.filter((row) => row.tunnel_status === "none" || row.tunnel_status === "inactive" || row.tunnel_status === "down").length;
  console.log(`${up} tunnel up, ${down} without a live tunnel`);
  if (orphans.length > 0) {
    console.log("");
    console.log("Tunnels with no matching user:");
    printTable(
      ["TUNNEL", "STATUS", "CONNS"],
      orphans.map((row) => [row.tunnel, row.tunnel_status, String(row.connections)]),
    );
  }
}

function seatLabel(user) {
  if (user?.access_seat || user?.gateway_seat) return "active";
  return "inactive";
}

function tunnelStatus(tunnel) {
  if (!tunnel) return "none";
  return String(tunnel.status || "unknown");
}

function connectionCount(tunnel) {
  return Array.isArray(tunnel?.connections) ? tunnel.connections.length : 0;
}

function formatWhen(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function printTable(header, rows) {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => String(row[index] ?? "").length)),
  );
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ");
  console.log(line(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
}

async function listAll(url) {
  const items = [];
  let page = 1;
  for (;;) {
    const sep = url.includes("?") ? "&" : "?";
    const { res, data } = await cfJson(`${url}${sep}page=${page}&per_page=100`, { headers });
    if (!data?.success && res.status !== 200) {
      const message = data?.errors?.[0]?.message || `HTTP ${res.status}`;
      console.error(`Cloudflare list failed: ${message}`);
      console.error(url);
      process.exit(1);
    }
    const batch = Array.isArray(data?.result) ? data.result : [];
    items.push(...batch);
    const totalPages = Number(data?.result_info?.total_pages || 1);
    if (batch.length === 0 || page >= totalPages) break;
    page += 1;
  }
  return items;
}

async function cfJson(url, init) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

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
