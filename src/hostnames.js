import {
  MANAGER_HOST,
  USER_TUNNEL_HOST_SUFFIX,
  USER_MOONLIGHT_HOST_SUFFIX,
} from "./config.js";

export function userTunnelHostname(username) {
  return `${username}${USER_TUNNEL_HOST_SUFFIX}`;
}

export function userMoonlightWebHostname(username) {
  return `${username}${USER_MOONLIGHT_HOST_SUFFIX}`;
}

function slugEmailPart(part) {
  return String(part || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Unique tunnel username from full email (local part + domain). */
export function usernameFromEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) {
    return slugEmailPart(normalized);
  }
  const local = slugEmailPart(normalized.slice(0, at));
  const domain = slugEmailPart(normalized.slice(at + 1));
  if (!local) return domain;
  if (!domain) return local;
  return `${local}-${domain}`;
}

export function isTunnelUserHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === MANAGER_HOST) return false;
  return host.endsWith(USER_TUNNEL_HOST_SUFFIX);
}
