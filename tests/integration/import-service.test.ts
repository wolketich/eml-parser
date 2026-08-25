import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BoardDetails,
  BoardSummary,
  MondayConnectionStatus,
  MondayMapping,
  ParsedFields,
} from "../../packages/mail-parser/src/types";
import { AppDatabase } from "../../apps/full-stack/src/server/database";
import type { Downloader } from "../../apps/full-stack/src/server/downloader";
import { ImportService } from "../../apps/full-stack/src/server/import-service";
import { buildColumnValues, type MondayGateway } from "../../apps/full-stack/src/server/monday";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

class FakeMonday implements MondayGateway {
  createCalls = 0;
  uploadCalls = 0;
  failFirstUpload = true;

  async testConnection(): Promise<MondayConnectionStatus> {
    return { configured: true, connected: true, userName: "Tester", error: null };
  }

  async listBoards(): Promise<BoardSummary[]> {
    return [];
  }

  async getBoard(): Promise<BoardDetails> {
    throw new Error("Not used");
  }

  async createItem(_mapping: MondayMapping, _fields: ParsedFields) {
    this.createCalls += 1;
    return { id: "item-1", url: "https://example.monday.com/item-1" };
  }

  async uploadFile() {
    this.uploadCalls += 1;
    if (this.failFirstUpload) {
      this.failFirstUpload = false;
      throw new Error("Temporary upload failure");
    }
    return { id: "asset-1", name: "source.eml", url: "https://files.example/1" };
  }
}

const unusedDownloader: Downloader = {
  async download() {
    throw new Error("Not used");
  },
};

describe("ImportService", () => {
  it("retries failed files without creating a duplicate monday item", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mail-import-"));
    tempDirs.push(directory);
    const database = new AppDatabase(directory);
    const importId = randomUUID();
    const sourcePath = path.join(directory, "source.eml");
    await fs.writeFile(sourcePath, "email");
    database.createImport({
      id: importId,
      sourceName: "source.eml",
      sourceEmlPath: sourcePath,
      emlSha256: "hash-1",
      messageKey: "message-1",
      subject: "New Entry",
      fields: {
        customerName: "Example Person",
        email: "person@example.com",
        phone: "",
        address: "",
        message: "Hello",
        submittedAt: "2026-06-04T09:15",
        formId: "123",
      },
      warnings: [],
      attachments: [
        {
          id: randomUUID(),
          importId,
          kind: "source",
          originalName: "source.eml",
          safeName: "source.eml",
          mimeType: "message/rfc822",
          sourceUrl: null,
          localPath: sourcePath,
          sizeBytes: 5,
          status: "downloaded",
        },
      ],
    });
    database.saveMapping({
      boardId: "board-1",
      groupId: "group-1",
      columns: { files: "files" },
    });
    const monday = new FakeMonday();
    const service = new ImportService(database, monday, unusedDownloader);

    const first = await service.import(importId);
    expect(first.status).toBe("partial");
    expect(first.mondayItemId).toBe("item-1");

    const retried = await service.retryFiles(importId);
    expect(retried.status).toBe("complete");
    expect(monday.createCalls).toBe(1);
    expect(monday.uploadCalls).toBe(2);
    database.close();
  });

  it("builds typed monday column values for create_item payloads", () => {
    const values = buildColumnValues(
      {
        boardId: "board-1",
        groupId: "group-1",
        columns: {
          email: "email_col",
          phone: "phone_col",
          address: "address_col",
          message: "message_col",
          files: "files_col",
        },
      },
      {
        customerName: "Example Person",
        email: "person@example.com",
        phone: "012336092",
        address: "D02 X285",
        message: "Hello",
        submittedAt: "2026-06-04T09:15",
        formId: "123",
      },
      {
        email_col: "email",
        phone_col: "phone",
        address_col: "text",
        message_col: "long_text",
        files_col: "file",
      },
    );

    expect(values).toEqual({
      email_col: { email: "person@example.com", text: "person@example.com" },
      phone_col: { phone: "+35312336092", countryShortName: "IE" },
      address_col: "D02 X285",
      message_col: { text: "Hello" },
    });
    expect(values).not.toHaveProperty("files_col");
  });

  it("completes without uploading files when file uploads are disabled", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mail-import-"));
    tempDirs.push(directory);
    const database = new AppDatabase(directory);
    const importId = randomUUID();
    const sourcePath = path.join(directory, "source.eml");
    await fs.writeFile(sourcePath, "email");
    database.createImport({
      id: importId,
      sourceName: "source.eml",
      sourceEmlPath: sourcePath,
      emlSha256: "hash-2",
      messageKey: "message-2",
      subject: "New Entry",
      fields: {
        customerName: "Example Person",
        email: "person@example.com",
        phone: "",
        address: "",
        message: "Hello",
        submittedAt: "2026-06-04T09:15",
        formId: "123",
      },
      warnings: [],
      attachments: [
        {
          id: randomUUID(),
          importId,
          kind: "source",
          originalName: "source.eml",
          safeName: "source.eml",
          mimeType: "message/rfc822",
          sourceUrl: null,
          localPath: sourcePath,
          sizeBytes: 5,
          status: "downloaded",
        },
      ],
    });
    database.saveMapping({
      boardId: "board-1",
      groupId: "group-1",
      uploadFiles: false,
      columns: {},
    });
    const monday = new FakeMonday();
    const service = new ImportService(database, monday, unusedDownloader);

    const result = await service.import(importId, { uploadFiles: false });

    expect(result.status).toBe("complete");
    expect(result.mondayItemId).toBe("item-1");
    expect(monday.createCalls).toBe(1);
    expect(monday.uploadCalls).toBe(0);
    database.close();
  });
});
