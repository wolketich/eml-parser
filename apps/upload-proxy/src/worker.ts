export interface WorkerEnv {
  MONDAY_API_TOKEN: string;
  BRIDGE_KEY: string;
  ALLOWED_ORIGINS?: string;
  REMOTE_FILE_HOSTS?: string;
  MONDAY_API_VERSION?: string;
  MAX_REMOTE_FILE_BYTES?: string;
}

const MONDAY_GRAPHQL_URL = "https://api.monday.com/v2";
const MONDAY_FILE_URL = "https://api.monday.com/v2/file";
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const origin = request.headers.get("Origin") ?? "";
    if (origin && !allowedOrigins(env).has(origin)) {
      return json({ error: "Origin is not allowed." }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return withCors(json({ ok: true }), origin);
    }

    if (!env.BRIDGE_KEY || request.headers.get("Authorization") !== `Bearer ${env.BRIDGE_KEY}`) {
      return withCors(json({ error: "Bridge access key is invalid." }, 401), origin);
    }
    if (!env.MONDAY_API_TOKEN) {
      return withCors(json({ error: "MONDAY_API_TOKEN is not configured on the bridge." }, 503), origin);
    }

    try {
      if (request.method === "POST" && url.pathname === "/monday/graphql") {
        return withCors(await proxyGraphql(request, env), origin);
      }
      if (request.method === "POST" && url.pathname === "/monday/upload") {
        return withCors(await proxyUpload(request, env), origin);
      }
      return withCors(json({ error: "Route not found." }, 404), origin);
    } catch (error) {
      return withCors(json({ error: errorMessage(error) }, 400), origin);
    }
  },
};

async function proxyGraphql(request: Request, env: WorkerEnv): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > 1_000_000) throw new Error("GraphQL request is too large.");
  const body = (await request.json()) as { query?: unknown; variables?: unknown };
  if (typeof body.query !== "string" || !body.query.trim()) {
    throw new Error("GraphQL query is required.");
  }
  return relayMondayResponse(
    await fetch(MONDAY_GRAPHQL_URL, {
      method: "POST",
      headers: mondayHeaders(request, env, true),
      body: JSON.stringify({ query: body.query, variables: body.variables ?? {} }),
    }),
  );
}

async function proxyUpload(request: Request, env: WorkerEnv): Promise<Response> {
  const incoming = await request.formData();
  const itemId = requiredText(incoming, "itemId", 100);
  const columnId = requiredText(incoming, "columnId", 200);
  const fileName = safeFilename(requiredText(incoming, "fileName", 240));
  const mimeType = optionalText(incoming, "mimeType", 200) || "application/octet-stream";
  const maxBytes = positiveInteger(env.MAX_REMOTE_FILE_BYTES) || DEFAULT_MAX_FILE_BYTES;
  const uploaded = incoming.get("file");
  let file: File;

  if (uploaded instanceof File && uploaded.size > 0) {
    if (uploaded.size > maxBytes) throw new Error("File exceeds the bridge size limit.");
    file = new File([uploaded], fileName, { type: uploaded.type || mimeType });
  } else {
    const sourceUrl = requiredText(incoming, "sourceUrl", 4_000);
    file = await fetchRemoteFile(sourceUrl, fileName, mimeType, env, maxBytes);
  }

  const query = `mutation ($file: File!, $itemId: ID!, $columnId: String!) { add_file_to_column(file: $file, item_id: $itemId, column_id: $columnId) { id name url } }`;
  const outgoing = new FormData();
  outgoing.append("query", query);
  outgoing.append("variables", JSON.stringify({ itemId, columnId, file: null }));
  outgoing.append("map", JSON.stringify({ file: ["variables.file"] }));
  outgoing.append("file", file, fileName);

  return relayMondayResponse(
    await fetch(MONDAY_FILE_URL, {
      method: "POST",
      headers: mondayHeaders(request, env, false),
      body: outgoing,
    }),
  );
}

async function fetchRemoteFile(
  rawUrl: string,
  fileName: string,
  fallbackType: string,
  env: WorkerEnv,
  maxBytes: number,
): Promise<File> {
  let url = checkedRemoteUrl(rawUrl, env);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "MailIntakeBridge/1.0" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (!location) throw new Error("Remote file returned an empty redirect.");
      url = checkedRemoteUrl(new URL(location, url).toString(), env);
      continue;
    }
    if (!response.ok) throw new Error(`Remote file returned HTTP ${response.status}.`);
    const declaredSize = Number(response.headers.get("Content-Length") ?? "0");
    if (declaredSize > maxBytes) throw new Error("Remote file exceeds the bridge size limit.");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) throw new Error("Remote file exceeds the bridge size limit.");
    const responseType = response.headers.get("Content-Type")?.split(";")[0]?.trim();
    return new File([bytes], fileName, { type: responseType || fallbackType });
  }
  throw new Error("Remote file redirected too many times.");
}

function checkedRemoteUrl(rawUrl: string, env: WorkerEnv): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Remote file URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Remote files must use a public HTTPS URL.");
  }
  const hosts = new Set(
    (env.REMOTE_FILE_HOSTS ?? "expertwindows.ie,www.expertwindows.ie")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!hosts.has(url.hostname.toLowerCase())) {
    throw new Error("Remote file host is not allowed by the bridge.");
  }
  return url;
}

function mondayHeaders(request: Request, env: WorkerEnv, jsonBody: boolean): Headers {
  const version = request.headers.get("API-Version")?.trim() || env.MONDAY_API_VERSION || "2026-04";
  if (!/^\d{4}-\d{2}$/.test(version)) throw new Error("monday API version is invalid.");
  const headers = new Headers({
    Authorization: env.MONDAY_API_TOKEN,
    "API-Version": version,
  });
  if (jsonBody) headers.set("Content-Type", "application/json");
  return headers;
}

async function relayMondayResponse(response: Response): Promise<Response> {
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function allowedOrigins(env: WorkerEnv): Set<string> {
  return new Set(
    (env.ALLOWED_ORIGINS ?? "https://wolketich.github.io")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
}

function corsHeaders(origin: string): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, API-Version",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin",
  });
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(origin)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function requiredText(form: FormData, key: string, maxLength: number): string {
  const value = optionalText(form, key, maxLength);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function optionalText(form: FormData, key: string, maxLength: number): string {
  const raw = form.get(key);
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (value.length > maxLength) throw new Error(`${key} is too long.`);
  return value;
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 180) || "attachment";
}

function positiveInteger(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Bridge request failed.";
}
