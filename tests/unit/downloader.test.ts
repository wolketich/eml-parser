import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SecureDownloader } from "../../apps/full-stack/src/server/downloader";

describe("SecureDownloader", () => {
  it("blocks loopback and private-network URLs before fetching", async () => {
    const downloader = new SecureDownloader(1024);
    await expect(
      downloader.download(
        "http://127.0.0.1/private-file",
        path.join(os.tmpdir(), "blocked-download"),
      ),
    ).rejects.toThrow(/private or local network/i);
  });
});
