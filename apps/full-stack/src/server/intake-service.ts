import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ImportRecord } from "../../../../packages/mail-parser/src/types.js";
import { AppDatabase, type NewAttachment } from "./database.js";
import { sanitizeFilename } from "./files.js";
import { sourceMimeType } from "./msg.js";
import { parseMail } from "./parser.js";

export class IntakeService {
  constructor(
    private readonly database: AppDatabase,
    private readonly dataDir: string,
  ) {}

  async ingest(raw: Buffer, sourceName: string): Promise<ImportRecord> {
    const parsed = await parseMail(raw, sourceName);
    const duplicate = this.database.findDuplicate(parsed.messageKey, parsed.hash);
    if (duplicate) return duplicate;

    const importId = randomUUID();
    const importDir = path.join(this.dataDir, "imports", importId);
    await fs.mkdir(importDir, { recursive: true });

    const sourceSafeName = sanitizeFilename(sourceName, "source.eml");
    const sourcePath = path.join(importDir, `source-${sourceSafeName}`);
    await fs.writeFile(sourcePath, raw);

    const attachments: NewAttachment[] = [
      {
        id: randomUUID(),
        importId,
        kind: "source",
        originalName: sourceSafeName,
        safeName: sourceSafeName,
        mimeType: sourceMimeType(sourceSafeName),
        sourceUrl: null,
        localPath: sourcePath,
        sizeBytes: raw.byteLength,
        status: "downloaded",
      },
    ];

    for (const attachment of parsed.mimeAttachments) {
      const localPath = path.join(importDir, attachment.safeName);
      await fs.writeFile(localPath, attachment.content);
      attachments.push({
        id: randomUUID(),
        importId,
        kind: "mime",
        originalName: attachment.originalName,
        safeName: attachment.safeName,
        mimeType: attachment.mimeType,
        sourceUrl: null,
        localPath,
        sizeBytes: attachment.content.byteLength,
        status: "downloaded",
      });
    }

    for (const remote of parsed.remoteFiles) {
      attachments.push({
        id: randomUUID(),
        importId,
        kind: "remote",
        originalName: remote.originalName,
        safeName: remote.safeName,
        mimeType: remote.mimeType,
        sourceUrl: remote.url,
        localPath: path.join(importDir, remote.safeName),
        sizeBytes: null,
        status: "pending",
      });
    }

    try {
      return this.database.createImport({
        id: importId,
        sourceName: sourceSafeName,
        sourceEmlPath: sourcePath,
        emlSha256: parsed.hash,
        messageKey: parsed.messageKey,
        subject: parsed.subject,
        leadType: parsed.leadType,
        emailPreview: parsed.emailPreview,
        fields: parsed.fields,
        warnings: parsed.warnings,
        attachments,
      });
    } catch (error) {
      await fs.rm(importDir, { recursive: true, force: true });
      throw error;
    }
  }
}
