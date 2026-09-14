import {
  MANAGER_HOST,
  IGDB_GATEWAY_PREFIX,
} from "./config.js";
import { isTunnelUserHost } from "./hostnames.js";
import { isIgdbPath } from "./igdb.js";

export function pickRoute(hostname, pathname, method) {
  if (hostname === MANAGER_HOST && pathname.startsWith(`${IGDB_GATEWAY_PREFIX}/`)) {
    return "igdb-gateway-relay";
  }
  if (isIgdbPath(pathname) && isTunnelUserHost(hostname)) {
    return "igdb-subdomain";
  }
  if (pathname === "/" && hostname === MANAGER_HOST) {
    return "landing";
  }
  if (
    hostname === MANAGER_HOST &&
    (pathname === "/api/get-token" || pathname.startsWith("/api/get-token/r/"))
  ) {
    return method === "OPTIONS" ? "get-token-options" : "get-token";
  }
  if (hostname === MANAGER_HOST && pathname === "/api/turn-ice-servers") {
    return method === "OPTIONS" ? "turn-ice-servers-options" : "turn-ice-servers";
  }
  if (hostname === MANAGER_HOST && pathname === "/api/device/code") {
    return method === "OPTIONS" ? "device-code-options" : "device-code";
  }
  if (hostname === MANAGER_HOST && pathname === "/api/device/poll") {
    return method === "OPTIONS" ? "device-poll-options" : "device-poll";
  }
  if (hostname === MANAGER_HOST && pathname === "/api/device/approve") {
    return "device-approve";
  }
  if (hostname === MANAGER_HOST && (pathname === "/link" || pathname === "/link/")) {
    return "link";
  }
  if (hostname === MANAGER_HOST && (pathname === "/deprovision" || pathname === "/deprovision/")) {
    return "deprovision-page";
  }
  if (hostname === MANAGER_HOST && pathname === "/api/deprovision-user") {
    return method === "OPTIONS" ? "deprovision-user-options" : "deprovision-user";
  }
  return "unmatched";
}
