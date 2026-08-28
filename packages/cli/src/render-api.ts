const BASE = "https://api.render.com/v1";

export interface RenderService {
  id: string;
  name: string;
  slug: string;
  type: string;
  serviceDetails?: { url?: string };
  suspended?: string;
}

export interface RenderEnvVar {
  key: string;
  value: string;
}

export interface RenderDeploy {
  id: string;
  status: string;
  commit?: { id: string; message: string; createdAt: string };
  createdAt: string;
  finishedAt?: string;
}

export interface RenderOwner {
  id: string;
  name: string;
  email: string;
  type: string;
}

export interface RenderPostgres {
  id: string;
  name: string;
  status: string;
  plan: string;
}

async function renderFetch<T>(path: string, apiKey: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Render API ${res.status}: ${path} — ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function listOwners(apiKey: string): Promise<RenderOwner[]> {
  const raw = await renderFetch<Array<{ owner: RenderOwner }>>("/owners?limit=10", apiKey);
  return raw.map((r) => r.owner);
}

export async function listServices(apiKey: string, name?: string): Promise<RenderService[]> {
  const params = new URLSearchParams({ limit: "100" });
  if (name) params.set("name", name);
  const raw = await renderFetch<Array<{ service: RenderService }>>(`/services?${params}`, apiKey);
  return raw.map((r) => r.service);
}

export async function getEnvVars(apiKey: string, serviceId: string): Promise<RenderEnvVar[]> {
  const raw = await renderFetch<Array<{ envVar: RenderEnvVar }>>(`/services/${serviceId}/env-vars?limit=100`, apiKey);
  return raw.map((r) => r.envVar);
}

export async function updateEnvVars(
  apiKey: string,
  serviceId: string,
  vars: Array<{ key: string; value: string }>,
): Promise<void> {
  await renderFetch(`/services/${serviceId}/env-vars`, apiKey, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(vars.map((v) => ({ key: v.key, value: v.value }))),
  });
}

export async function listDeploys(apiKey: string, serviceId: string, limit = 1): Promise<RenderDeploy[]> {
  const raw = await renderFetch<Array<{ deploy: RenderDeploy }>>(`/services/${serviceId}/deploys?limit=${limit}`, apiKey);
  return raw.map((r) => r.deploy);
}

export async function listPostgres(apiKey: string, name?: string): Promise<RenderPostgres[]> {
  const params = new URLSearchParams({ limit: "10" });
  if (name) params.set("name", name);
  const raw = await renderFetch<Array<{ postgres: RenderPostgres }>>(`/postgres?${params}`, apiKey);
  return raw.map((r) => r.postgres);
}

export async function checkHealth(url: string): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
