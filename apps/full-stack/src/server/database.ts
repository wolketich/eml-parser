import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AttachmentStatus,
  ImportAttachment,
  ImportRecord,
  ImportStatus,
  LeadType,
  MondayMapping,
  ParsedFields,
} from "../../../../packages/mail-parser/src/types.js";

interface ImportRow {
  id: string;
  source_name: string;
  source_eml_path: string | null;
  eml_sha256: string;
  message_key: string | null;
  subject: string;
  lead_type: LeadType;
  email_preview: string;
  customer_name: string;
  email: string;
  phone: string;
  address: string;
  message: string;
  submitted_at: string;
  form_id: string;
  warnings_json: string;
  status: ImportStatus;
  monday_item_id: string | null;
  monday_item_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface AttachmentRow {
  id: string;
  import_id: string;
  kind: ImportAttachment["kind"];
  original_name: string;
  safe_name: string;
  mime_type: string;
  source_url: string | null;
  local_path: string | null;
  size_bytes: number | null;
  status: AttachmentStatus;
  monday_asset_id: string | null;
  error: string | null;
}

export interface NewAttachment {
  id: string;
  importId: string;
  kind: ImportAttachment["kind"];
  originalName: string;
  safeName: string;
  mimeType: string;
  sourceUrl: string | null;
  localPath: string | null;
  sizeBytes: number | null;
  status: AttachmentStatus;
}

export interface NewImport {
  id: string;
  sourceName: string;
  sourceEmlPath: string;
  emlSha256: string;
  messageKey: string | null;
  subject: string;
  leadType?: LeadType;
  emailPreview?: string;
  fields: ParsedFields;
  warnings: string[];
  attachments: NewAttachment[];
}

export class AppDatabase {
  readonly db: Database.Database;

  constructor(private readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "mail-intake.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS imports (
        id TEXT PRIMARY KEY,
        source_name TEXT NOT NULL,
        source_eml_path TEXT,
        eml_sha256 TEXT NOT NULL UNIQUE,
        message_key TEXT UNIQUE,
        subject TEXT NOT NULL DEFAULT '',
        lead_type TEXT NOT NULL DEFAULT 'contact_form',
        email_preview TEXT NOT NULL DEFAULT '',
        customer_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        submitted_at TEXT NOT NULL DEFAULT '',
        form_id TEXT NOT NULL DEFAULT '',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'parsed',
        monday_item_id TEXT,
        monday_item_url TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        original_name TEXT NOT NULL,
        safe_name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        source_url TEXT,
        local_path TEXT,
        size_bytes INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        monday_asset_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attachments_import_id
        ON attachments(import_id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const importColumns = new Set(
      (this.db.pragma("table_info(imports)") as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!importColumns.has("lead_type")) {
      this.db.exec(
        "ALTER TABLE imports ADD COLUMN lead_type TEXT NOT NULL DEFAULT 'contact_form'",
      );
    }
    if (!importColumns.has("email_preview")) {
      this.db.exec(
        "ALTER TABLE imports ADD COLUMN email_preview TEXT NOT NULL DEFAULT ''",
      );
    }
  }

  findDuplicate(messageKey: string | null, hash: string): ImportRecord | null {
    const row = messageKey
      ? this.db
          .prepare(
            "SELECT * FROM imports WHERE message_key = ? OR eml_sha256 = ? ORDER BY created_at LIMIT 1",
          )
          .get(messageKey, hash)
      : this.db.prepare("SELECT * FROM imports WHERE eml_sha256 = ? LIMIT 1").get(hash);
    return row ? this.hydrateImport(row as ImportRow, true) : null;
  }

  createImport(input: NewImport): ImportRecord {
    const now = new Date().toISOString();
    const insertImport = this.db.prepare(`
      INSERT INTO imports (
        id, source_name, source_eml_path, eml_sha256, message_key, subject,
        lead_type, email_preview,
        customer_name, email, phone, address, message, submitted_at, form_id,
        warnings_json, status, created_at, updated_at
      ) VALUES (
        @id, @sourceName, @sourceEmlPath, @emlSha256, @messageKey, @subject,
        @leadType, @emailPreview,
        @customerName, @email, @phone, @address, @message, @submittedAt, @formId,
        @warningsJson, 'parsed', @now, @now
      )
    `);
    const insertAttachment = this.db.prepare(`
      INSERT INTO attachments (
        id, import_id, kind, original_name, safe_name, mime_type, source_url,
        local_path, size_bytes, status, created_at, updated_at
      ) VALUES (
        @id, @importId, @kind, @originalName, @safeName, @mimeType, @sourceUrl,
        @localPath, @sizeBytes, @status, @now, @now
      )
    `);

    this.db.transaction(() => {
      insertImport.run({
        id: input.id,
        sourceName: input.sourceName,
        sourceEmlPath: input.sourceEmlPath,
        emlSha256: input.emlSha256,
        messageKey: input.messageKey,
        subject: input.subject,
        leadType: input.leadType ?? "contact_form",
        emailPreview: input.emailPreview ?? "",
        customerName: input.fields.customerName,
        email: input.fields.email,
        phone: input.fields.phone,
        address: input.fields.address,
        message: input.fields.message,
        submittedAt: input.fields.submittedAt,
        formId: input.fields.formId,
        warningsJson: JSON.stringify(input.warnings),
        now,
      });
      for (const attachment of input.attachments) {
        insertAttachment.run({ ...attachment, now });
      }
    })();

    return this.getImport(input.id)!;
  }

  listImports(limit = 100): ImportRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM imports ORDER BY created_at DESC LIMIT ?")
      .all(limit) as ImportRow[];
    return rows.map((row) => this.hydrateImport(row, false));
  }

  getImport(id: string): ImportRecord | null {
    const row = this.db.prepare("SELECT * FROM imports WHERE id = ?").get(id) as
      | ImportRow
      | undefined;
    return row ? this.hydrateImport(row, false) : null;
  }

  deleteImport(id: string): boolean {
    const row = this.getImportRow(id);
    if (!row) return false;
    this.db.prepare("DELETE FROM imports WHERE id = ?").run(id);
    const importDir = path.join(this.dataDir, "imports", id);
    if (fs.existsSync(importDir)) {
      fs.rmSync(importDir, { recursive: true, force: true });
    }
    return true;
  }

  clearImports(): number {
    const rows = this.db.prepare("SELECT id FROM imports").all() as { id: string }[];
    this.db.prepare("DELETE FROM imports").run();
    for (const row of rows) {
      const importDir = path.join(this.dataDir, "imports", row.id);
      if (fs.existsSync(importDir)) {
        fs.rmSync(importDir, { recursive: true, force: true });
      }
    }
    return rows.length;
  }

  getImportRow(id: string): ImportRow | null {
    return (
      (this.db.prepare("SELECT * FROM imports WHERE id = ?").get(id) as
        | ImportRow
        | undefined) ?? null
    );
  }

  getAttachment(importId: string, attachmentId: string): AttachmentRow | null {
    const row = this.db
      .prepare("SELECT * FROM attachments WHERE id = ? AND import_id = ?")
      .get(attachmentId, importId) as AttachmentRow | undefined;
    return row ?? null;
  }

  getAttachmentRows(importId: string): AttachmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM attachments
         WHERE import_id = ?
         ORDER BY CASE kind WHEN 'source' THEN 0 WHEN 'mime' THEN 1 ELSE 2 END, created_at`,
      )
      .all(importId) as AttachmentRow[];
  }

  updateFields(id: string, fields: ParsedFields): ImportRecord | null {
    this.db
      .prepare(`
        UPDATE imports SET
          customer_name = @customerName,
          email = @email,
          phone = @phone,
          address = @address,
          message = @message,
          submitted_at = @submittedAt,
          form_id = @formId,
          updated_at = @now
        WHERE id = @id
      `)
      .run({ id, ...fields, now: new Date().toISOString() });
    return this.getImport(id);
  }

  updateImportState(
    id: string,
    status: ImportStatus,
    values: {
      mondayItemId?: string | null;
      mondayItemUrl?: string | null;
      error?: string | null;
    } = {},
  ): void {
    const current = this.getImportRow(id);
    if (!current) return;
    this.db
      .prepare(`
        UPDATE imports SET
          status = @status,
          monday_item_id = @mondayItemId,
          monday_item_url = @mondayItemUrl,
          error = @error,
          updated_at = @now
        WHERE id = @id
      `)
      .run({
        id,
        status,
        mondayItemId: values.mondayItemId ?? current.monday_item_id,
        mondayItemUrl: values.mondayItemUrl ?? current.monday_item_url,
        error: values.error === undefined ? current.error : values.error,
        now: new Date().toISOString(),
      });
  }

  updateAttachment(
    id: string,
    values: Partial<
      Pick<
        AttachmentRow,
        | "local_path"
        | "size_bytes"
        | "mime_type"
        | "status"
        | "monday_asset_id"
        | "error"
      >
    >,
  ): void {
    const current = this.db
      .prepare("SELECT * FROM attachments WHERE id = ?")
      .get(id) as AttachmentRow | undefined;
    if (!current) return;
    this.db
      .prepare(`
        UPDATE attachments SET
          local_path = @localPath,
          size_bytes = @sizeBytes,
          mime_type = @mimeType,
          status = @status,
          monday_asset_id = @mondayAssetId,
          error = @error,
          updated_at = @now
        WHERE id = @id
      `)
      .run({
        id,
        localPath: values.local_path === undefined ? current.local_path : values.local_path,
        sizeBytes: values.size_bytes === undefined ? current.size_bytes : values.size_bytes,
        mimeType: values.mime_type ?? current.mime_type,
        status: values.status ?? current.status,
        mondayAssetId:
          values.monday_asset_id === undefined
            ? current.monday_asset_id
            : values.monday_asset_id,
        error: values.error === undefined ? current.error : values.error,
        now: new Date().toISOString(),
      });
  }

  getMapping(): MondayMapping | null {
    const row = this.db
      .prepare("SELECT value_json FROM settings WHERE key = 'monday_mapping'")
      .get() as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as MondayMapping) : null;
  }

  saveMapping(mapping: MondayMapping): MondayMapping {
    this.db
      .prepare(`
        INSERT INTO settings (key, value_json, updated_at)
        VALUES ('monday_mapping', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(mapping), new Date().toISOString());
    return mapping;
  }

  private hydrateImport(row: ImportRow, duplicate: boolean): ImportRecord {
    const attachments = this.getAttachmentRows(row.id).map(
      (attachment): ImportAttachment => ({
        id: attachment.id,
        kind: attachment.kind,
        originalName: attachment.original_name,
        mimeType: attachment.mime_type,
        sourceUrl: attachment.source_url,
        sizeBytes: attachment.size_bytes,
        status: attachment.status,
        error: attachment.error,
        mondayAssetId: attachment.monday_asset_id,
        viewable: Boolean(
          attachment.local_path && fs.existsSync(attachment.local_path),
        ),
        downloadable:
          Boolean(attachment.local_path && fs.existsSync(attachment.local_path)) ||
          (attachment.kind === "remote" && Boolean(attachment.source_url)),
      }),
    );
    return {
      id: row.id,
      sourceName: row.source_name,
      subject: row.subject,
      leadType: row.lead_type,
      emailPreview: row.email_preview,
      fields: {
        customerName: row.customer_name,
        email: row.email,
        phone: row.phone,
        address: row.address,
        message: row.message,
        submittedAt: row.submitted_at,
        formId: row.form_id,
      },
      warnings: JSON.parse(row.warnings_json) as string[],
      status: row.status,
      duplicate,
      mondayItemId: row.monday_item_id,
      mondayItemUrl: row.monday_item_url,
      error: row.error,
      attachments,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
