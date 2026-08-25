import type { ImportOptions, ImportRecord } from "../../../../packages/mail-parser/src/types.js";
import { AppDatabase } from "./database.js";
import type { Downloader } from "./downloader.js";
import type { MondayGateway } from "./monday.js";

export class ImportService {
  constructor(
    private readonly database: AppDatabase,
    private readonly monday: MondayGateway,
    private readonly downloader: Downloader,
  ) {}

  async import(id: string, options: ImportOptions = {}): Promise<ImportRecord> {
    return this.run(id, false, options);
  }

  async retryFiles(id: string, options: ImportOptions = {}): Promise<ImportRecord> {
    return this.run(id, true, options);
  }

  private async run(
    id: string,
    retryOnly: boolean,
    options: ImportOptions = {},
  ): Promise<ImportRecord> {
    const record = this.database.getImport(id);
    if (!record) throw new Error("Import record was not found.");
    if (record.status === "complete") return record;

    const mapping = this.database.getMapping();
    if (!mapping?.boardId || !mapping.groupId) {
      throw new Error("Select a monday board and group in Settings before importing.");
    }
    const uploadFiles = options.uploadFiles ?? mapping.uploadFiles ?? true;
    const filesColumnId = mapping.columns.files;
    if (uploadFiles && !filesColumnId) {
      throw new Error("Map a monday Files column before importing with file uploads.");
    }
    if (retryOnly && !record.mondayItemId) {
      throw new Error("This import has no monday item to retry files against.");
    }
    if (retryOnly && !uploadFiles) {
      throw new Error("File uploads are disabled for this import.");
    }

    this.database.updateImportState(id, "importing", { error: null });
    let itemId = record.mondayItemId;
    let itemUrl = record.mondayItemUrl;

    if (!itemId) {
      try {
        const item = await this.monday.createItem(mapping, record.fields);
        itemId = item.id;
        itemUrl = item.url;
        this.database.updateImportState(id, "importing", {
          mondayItemId: itemId,
          mondayItemUrl: itemUrl,
          error: null,
        });
      } catch (error) {
        this.database.updateImportState(id, "failed", {
          error: errorMessage(error),
        });
        return this.database.getImport(id)!;
      }
    }

    if (!uploadFiles) {
      this.database.updateImportState(id, "complete", {
        mondayItemId: itemId,
        mondayItemUrl: itemUrl,
        error: null,
      });
      return this.database.getImport(id)!;
    }

    const attachments = this.database
      .getAttachmentRows(id)
      .filter((attachment) => attachment.status !== "uploaded");
    let failures = 0;

    for (const attachment of attachments) {
      try {
        let localPath = attachment.local_path;
        if (attachment.kind === "remote" && attachment.status !== "downloaded") {
          if (!attachment.source_url || !localPath) {
            throw new Error("Remote attachment is missing its source URL.");
          }
          const download = await this.downloader.download(
            attachment.source_url,
            localPath,
          );
          localPath = download.path;
          this.database.updateAttachment(attachment.id, {
            local_path: download.path,
            size_bytes: download.sizeBytes,
            mime_type: download.mimeType,
            status: "downloaded",
            error: null,
          });
        }
        if (!localPath) throw new Error("Attachment file is no longer available.");

        const asset = await this.monday.uploadFile(
          itemId,
          filesColumnId!,
          localPath,
          attachment.original_name,
          attachment.mime_type,
        );
        this.database.updateAttachment(attachment.id, {
          status: "uploaded",
          monday_asset_id: asset.id,
          error: null,
        });
      } catch (error) {
        failures += 1;
        this.database.updateAttachment(attachment.id, {
          status: "failed",
          error: errorMessage(error),
        });
      }
    }

    this.database.updateImportState(id, failures ? "partial" : "complete", {
      mondayItemId: itemId,
      mondayItemUrl: itemUrl,
      error: failures
        ? `${failures} attachment${failures === 1 ? "" : "s"} could not be uploaded.`
        : null,
    });
    return this.database.getImport(id)!;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Import failed.";
}
