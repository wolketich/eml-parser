import { lookup } from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export interface DownloadResult {
  path: string;
  sizeBytes: number;
  mimeType: string;
}

export interface Downloader {
  download(url: string, destination: string): Promise<DownloadResult>;
}

export class SecureDownloader implements Downloader {
  constructor(
    private readonly maxBytes: number,
    private readonly timeoutMs = 15_000,
  ) {}

  async download(url: string, destination: string): Promise<DownloadResult> {
    let currentUrl = new URL(url);
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      await assertPublicUrl(currentUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(currentUrl, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": "MailIntake/1.0" },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new Error("Remote server returned an empty redirect.");
          currentUrl = new URL(location, currentUrl);
          continue;
        }
        if (!response.ok) {
          throw new Error(`Remote file returned HTTP ${response.status}.`);
        }

        const declaredSize = Number(response.headers.get("content-length") ?? "0");
        if (declaredSize > this.maxBytes) {
          throw new Error(`Remote file exceeds the ${formatBytes(this.maxBytes)} limit.`);
        }
        if (!response.body) throw new Error("Remote file returned an empty response.");

        await fs.mkdir(path.dirname(destination), { recursive: true });
        const chunks: Uint8Array[] = [];
        let sizeBytes = 0;
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const bytes = Buffer.from(value);
          sizeBytes += bytes.byteLength;
          if (sizeBytes > this.maxBytes) {
            await reader.cancel();
            throw new Error(
              `Remote file exceeds the ${formatBytes(this.maxBytes)} limit.`,
            );
          }
          chunks.push(bytes);
        }
        await fs.writeFile(destination, Buffer.concat(chunks));
        return {
          path: destination,
          sizeBytes,
          mimeType:
            response.headers.get("content-type")?.split(";")[0]?.trim() ||
            "application/octet-stream",
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Remote file download timed out.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("Remote file redirected too many times.");
  }
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS file URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("Authenticated file URLs are not supported.");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Remote file URL resolves to a private or local network address.");
  }
}

function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
