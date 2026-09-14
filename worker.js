import { handleGetToken } from "./src/get-token.js";
import { handleDeviceApprove, handleDeviceCode, handleDevicePoll, handleLinkPage } from "./src/device-pairing.js";
import { handleDeprovisionPage, handleDeprovisionUser } from "./src/deprovision.js";
import { forwardIgdbToTunnel, handleIgdbGatewayRelay } from "./src/igdb.js";
import { corsPreflight } from "./src/http.js";
import { pickRoute } from "./src/routes.js";
import { handleTurnIceServers } from "./src/turn.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = request.headers.get("Host") || url.hostname;
    const route = pickRoute(hostname, url.pathname, request.method);

    if (route === "igdb-gateway-relay") {
      return handleIgdbGatewayRelay(request, env);
    }
    if (route === "igdb-subdomain") {
      return forwardIgdbToTunnel(request, env, hostname);
    }
    if (route === "landing") {
      return Response.redirect(new URL("/api/get-token", request.url).toString(), 302);
    }
    if (route === "get-token-options") {
      return corsPreflight(request);
    }
    if (route === "get-token") {
      return handleGetToken(request, env);
    }
    if (route === "turn-ice-servers-options") {
      return corsPreflight(request, { methods: "GET, POST, OPTIONS" });
    }
    if (route === "turn-ice-servers") {
      return handleTurnIceServers(request, env);
    }
    if (route === "device-code-options") {
      return corsPreflight(request, { methods: "POST, OPTIONS" });
    }
    if (route === "device-code") {
      return handleDeviceCode(request, env);
    }
    if (route === "device-poll-options") {
      return corsPreflight(request, { methods: "GET, OPTIONS" });
    }
    if (route === "device-poll") {
      return handleDevicePoll(request, env);
    }
    if (route === "device-approve") {
      return handleDeviceApprove(request, env);
    }
    if (route === "link") {
      return handleLinkPage(request);
    }
    if (route === "deprovision-page") {
      return handleDeprovisionPage(request);
    }
    if (route === "deprovision-user-options") {
      return corsPreflight(request, { methods: "POST, OPTIONS" });
    }
    if (route === "deprovision-user") {
      return handleDeprovisionUser(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};
