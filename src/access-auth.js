export function emailFromAccessJwt(request) {
  const jwt =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    readAccessJwtFromCookie(request);
  if (!jwt) return { error: "not_authenticated" };
  let email;
  try {
    email = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email;
  } catch {
    return { error: "invalid_token" };
  }
  if (!email) return { error: "no_email" };
  return { email: String(email) };
}

export function readAccessJwtFromCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return String(match[1] || "").trim();
  }
}
