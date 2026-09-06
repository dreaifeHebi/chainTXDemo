import { spawnSync } from "node:child_process";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const project = "chaintxdemo";
const domain = "chaintxdemo.dreaifehebi.com";
const zoneName = "dreaifehebi.com";
const mode = process.argv[2];
if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in repository secrets.");
if (!["project", "domain"].includes(mode)) throw new Error("Usage: node scripts/cloudflare-setup.mjs project|domain");
if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error("Invalid CLOUDFLARE_ACCOUNT_ID");

async function api(path, method = "GET", body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    const error = new Error(`Cloudflare ${method} ${path}: HTTP ${response.status}, error codes ${(data.errors || []).map(e => e.code).join(",")}. Check token permissions.`);
    error.status = response.status;
    throw error;
  }
  return data.result;
}

const base = `/accounts/${account}/pages/projects/${project}`;
if (mode === "project") {
  try {
    const existing = await api(base);
    if (existing.production_branch !== "master") throw new Error("Existing Pages project uses another production branch; refusing to change it.");
    console.log(`Pages project ${project} already exists.`);
  } catch (error) {
    if (error.status !== 404) throw error;
    const result = spawnSync("npx", ["wrangler", "pages", "project", "create", project, "--production-branch", "master"], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Pages project creation failed.");
  }
} else {
  const existing = await api(base);
  const target = existing.subdomain;
  if (target !== `${project}.pages.dev`) throw new Error("Unexpected Pages hostname; refusing DNS changes.");
  const zones = await api(`/zones?name=${zoneName}`);
  if (zones.length !== 1) throw new Error(`Expected exactly one accessible zone for ${zoneName}.`);
  const dnsPath = `/zones/${zones[0].id}/dns_records`;
  const records = await api(`${dnsPath}?name=${domain}`);
  if (records.length && !records.every(r => r.type === "CNAME" && r.content.replace(/\.$/, "") === target)) {
    throw new Error(`DNS for ${domain} already points elsewhere; refusing to overwrite it.`);
  }
  const domains = await api(`${base}/domains`);
  if (!domains.some(d => d.name === domain)) await api(`${base}/domains`, "POST", { name: domain });
  if (!records.length) {
    await api(dnsPath, "POST", { type: "CNAME", name: domain, content: target, ttl: 1, proxied: true });
  }
  const result = await api(`${base}/domains/${domain}`);
  console.log(`Custom domain ${domain}: ${result.status}; DNS points to ${target}.`);
}
