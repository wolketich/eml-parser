import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type WorkerEnv } from "../../apps/upload-proxy/src/worker";

const env: WorkerEnv = {
  MONDAY_API_TOKEN: "monday-secret",
  BRIDGE_KEY: "bridge-secret",
  ALLOWED_ORIGINS: "https://wolketich.github.io",
  REMOTE_FILE_HOSTS: "expertwindows.ie",
  MONDAY_API_VERSION: "2026-04",
  MAX_REMOTE_FILE_BYTES: "1024",
};

const origin = "https://wolketich.github.io";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upload bridge", () => {
  it("answers browser preflight requests for the configured origin", async () => {
    const response = await worker.fetch(
      new Request("https://bridge.example/monday/upload", {
        method: "OPTIONS",
        headers: { Origin: origin },
      }),
      env,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("rejects unknown origins and invalid bridge keys", async () => {
    const wrongOrigin = await worker.fetch(
      new Request("https://bridge.example/health", {
        headers: { Origin: "https://attacker.example" },
      }),
      env,
    );
    expect(wrongOrigin.status).toBe(403);

    const wrongKey = await worker.fetch(
      bridgeRequest("/monday/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
        body: JSON.stringify({ query: "query { me { name } }" }),
      }),
      env,
    );
    expect(wrongKey.status).toBe(401);
  });

  it("forwards GraphQL with the monday token held by the bridge", async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toBeInstanceOf(Headers);
      expect((init?.headers as Headers).get("Authorization")).toBe("monday-secret");
      return Response.json({ data: { me: { name: "Test User" } } });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await worker.fetch(
      bridgeRequest("/monday/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query { me { name } }" }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { me: { name: "Test User" } } });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("downloads an allowed remote file server-side and uploads it to monday", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://expertwindows.ie/")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "image/jpeg", "Content-Length": "3" },
        });
      }
      expect(url).toBe("https://api.monday.com/v2/file");
      const form = init?.body as FormData;
      expect(form.get("file")).toBeInstanceOf(File);
      expect((form.get("file") as File).name).toBe("window.jpg");
      expect((init?.headers as Headers).get("Authorization")).toBe("monday-secret");
      return Response.json({ data: { add_file_to_column: { id: "asset-1" } } });
    });
    vi.stubGlobal("fetch", upstream);

    const form = new FormData();
    form.set("itemId", "123");
    form.set("columnId", "files");
    form.set("fileName", "window.jpg");
    form.set("mimeType", "image/jpeg");
    form.set("sourceUrl", "https://expertwindows.ie/wp-content/uploads/wpforms/window.jpg");
    const response = await worker.fetch(
      bridgeRequest("/monday/upload", { method: "POST", body: form }),
      env,
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  });

  it("does not fetch remote files from unapproved hosts", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const form = new FormData();
    form.set("itemId", "123");
    form.set("columnId", "files");
    form.set("fileName", "window.jpg");
    form.set("sourceUrl", "https://attacker.example/window.jpg");

    const response = await worker.fetch(
      bridgeRequest("/monday/upload", { method: "POST", body: form }),
      env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Remote file host is not allowed by the bridge.",
    });
    expect(upstream).not.toHaveBeenCalled();
  });
});

function bridgeRequest(pathname: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  if (!headers.has("Authorization")) headers.set("Authorization", "Bearer bridge-secret");
  return new Request(`https://bridge.example${pathname}`, { ...init, headers });
}
