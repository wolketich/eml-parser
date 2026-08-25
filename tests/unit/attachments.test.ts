import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/full-stack/src/server/app";
import { AppDatabase } from "../../apps/full-stack/src/server/database";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("attachment file endpoint", () => {
  it("serves a stored attachment file", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-attach-"));
    tempDirs.push(dataDir);
    const database = new AppDatabase(dataDir);
    const importId = randomUUID();
    const attachmentId = randomUUID();
    const filePath = path.join(dataDir, "sample.txt");
    await fs.writeFile(filePath, "hello file");

    database.createImport({
      id: importId,
      sourceName: "submission.eml",
      sourceEmlPath: filePath,
      emlSha256: "hash",
      messageKey: null,
      subject: "Subject",
      fields: {
        customerName: "Example",
        email: "person@example.com",
        phone: "",
        address: "",
        message: "",
        submittedAt: "",
        formId: "",
      },
      warnings: [],
      attachments: [
        {
          id: attachmentId,
          importId,
          kind: "mime",
          originalName: "sample.txt",
          safeName: "sample.txt",
          mimeType: "text/plain",
          sourceUrl: null,
          localPath: filePath,
          sizeBytes: 10,
          status: "downloaded",
        },
      ],
    });

    const app = await createApp({ database, dataDir, serveClient: false });
    const response = await app.inject({
      method: "GET",
      url: `/api/imports/${importId}/attachments/${attachmentId}/file`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toBe("hello file");

    const download = await app.inject({
      method: "GET",
      url: `/api/imports/${importId}/attachments/${attachmentId}/file?download=1`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.body).toBe("hello file");

    await app.close();
    database.close();
  });
});

describe("delete import", () => {
  it("removes the import record and files from disk", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-delete-"));
    tempDirs.push(dataDir);
    const database = new AppDatabase(dataDir);
    const importId = randomUUID();
    const importDir = path.join(dataDir, "imports", importId);
    const filePath = path.join(importDir, "sample.txt");
    await fs.mkdir(importDir, { recursive: true });
    await fs.writeFile(filePath, "delete me");

    database.createImport({
      id: importId,
      sourceName: "submission.eml",
      sourceEmlPath: filePath,
      emlSha256: "delete-hash",
      messageKey: null,
      subject: "Subject",
      fields: {
        customerName: "Example",
        email: "person@example.com",
        phone: "",
        address: "",
        message: "",
        submittedAt: "",
        formId: "",
      },
      warnings: [],
      attachments: [],
    });

    const app = await createApp({ database, dataDir, serveClient: false });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/imports/${importId}`,
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(database.getImport(importId)).toBeNull();
    await expect(fs.stat(importDir)).rejects.toThrow();
    await app.close();
    database.close();
  });

  it("clears every import from the queue", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-clear-"));
    tempDirs.push(dataDir);
    const database = new AppDatabase(dataDir);
    const ids = [randomUUID(), randomUUID()];

    for (const importId of ids) {
      const importDir = path.join(dataDir, "imports", importId);
      await fs.mkdir(importDir, { recursive: true });
      await fs.writeFile(path.join(importDir, "sample.txt"), "clear me");
      database.createImport({
        id: importId,
        sourceName: "submission.eml",
        sourceEmlPath: path.join(importDir, "sample.txt"),
        emlSha256: `hash-${importId}`,
        messageKey: null,
        subject: "Subject",
        fields: {
          customerName: "Example",
          email: "person@example.com",
          phone: "",
          address: "",
          message: "",
          submittedAt: "",
          formId: "",
        },
        warnings: [],
        attachments: [],
      });
    }

    const app = await createApp({ database, dataDir, serveClient: false });
    const response = await app.inject({
      method: "DELETE",
      url: "/api/imports",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, deleted: 2 });
    expect(database.listImports()).toHaveLength(0);
    for (const importId of ids) {
      await expect(fs.stat(path.join(dataDir, "imports", importId))).rejects.toThrow();
    }
    await app.close();
    database.close();
  });
});
