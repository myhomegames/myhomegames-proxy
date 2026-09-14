export async function ensureDnsCname(zoneId, headers, name, content) {
  const existing = await findDnsCname(zoneId, headers, name);
  if (existing) {
    if (existing.content === content) return;
    await fetch("https://api.cloudflare.com/client/v4/zones/" + zoneId + "/dns_records/" + existing.id, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ content, proxied: true }),
    });
    return;
  }
  await fetch("https://api.cloudflare.com/client/v4/zones/" + zoneId + "/dns_records", {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "CNAME", name, content, proxied: true }),
  });
}

export async function findDnsCname(zoneId, headers, name) {
  const listResp = await fetch(
    "https://api.cloudflare.com/client/v4/zones/" + zoneId + "/dns_records?type=CNAME&name=" + encodeURIComponent(name),
    { headers },
  );
  const listData = await listResp.json();
  return listData?.result?.find((r) => r.name === name || r.name === name + ".") || null;
}

export async function deleteDnsCname(zoneId, headers, name) {
  const existing = await findDnsCname(zoneId, headers, name);
  if (!existing) {
    return { name, deleted: false, reason: "not_found" };
  }
  const delResp = await fetch(
    "https://api.cloudflare.com/client/v4/zones/" + zoneId + "/dns_records/" + existing.id,
    { method: "DELETE", headers },
  );
  const delData = await delResp.json().catch(() => ({}));
  return {
    name,
    id: existing.id,
    deleted: Boolean(delData?.success) || delResp.status === 200 || delResp.status === 404,
    status: delResp.status,
    errors: delData?.errors || null,
  };
}
