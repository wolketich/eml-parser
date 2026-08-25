import PostalMime from "postal-mime";
import MsgReaderModule from "@kenjiuno/msgreader";
import { parseLeadContent } from "../../../packages/mail-parser/src/lead-parser";
import type { LeadType, ParsedFields } from "../../../packages/mail-parser/src/types";

type ColumnKey = keyof ParsedFields | "files";
type GuidedKey = "customerName" | "email" | "phone" | "address";

interface Config {
  bridgeUrl: string;
  bridgeKey: string;
  apiVersion: string;
  boardId: string;
  groupId: string;
  columns: Partial<Record<ColumnKey, string>>;
  columnTypes: Record<string, string>;
}

interface AttachmentRecord {
  id: string;
  kind: "source" | "mime" | "remote";
  name: string;
  type: string;
  size: number | null;
  blob?: Blob;
  url?: string;
  status: "ready" | "uploading" | "uploaded" | "failed";
  error: string | null;
}

interface LeadRecord {
  id: string;
  duplicateKey: string;
  sourceName: string;
  subject: string;
  leadType: LeadType;
  emailPreview: string;
  fields: ParsedFields;
  warnings: string[];
  attachments: AttachmentRecord[];
  status: "ready" | "importing" | "partial" | "complete" | "failed";
  error: string | null;
  itemId: string | null;
  itemUrl: string | null;
  open: boolean;
  guideKey: GuidedKey | null;
  guideDraft: string;
}

interface BoardDetails {
  id: string;
  name: string;
  groups: Array<{ id: string; title: string }>;
  columns: Array<{ id: string; title: string; type: string }>;
}

interface EmailLike {
  subject?: string;
  date?: string;
  messageId?: string;
  references?: string;
  inReplyTo?: string;
  html?: string;
  text?: string;
  from?: { name?: string; address?: string };
  attachments?: Array<{
    filename?: string;
    mimeType?: string;
    content?: string | ArrayBuffer | Uint8Array;
    encoding?: string;
    disposition?: string;
    related?: boolean;
    contentId?: string;
  }>;
}

interface MsgReaderInstance {
  getFileData(): any;
  getAttachment(descriptor: any): {
    fileName?: string;
    content?: Uint8Array;
  };
}

type MsgReaderConstructor = new (raw: ArrayBuffer) => MsgReaderInstance;

declare global {
  interface Window {
    MAIL_INTAKE_DEFAULTS?: Partial<Config> & {
      columns?: Partial<Record<ColumnKey, string>>;
    };
  }
}

const SETTINGS_KEY = "mail-intake-settings-v3";
const IMPORTED_KEY = "mail-intake-imported-v2";
const MAX_REMOTE_BYTES = 25 * 1024 * 1024;
const guidedFields: Array<{
  key: GuidedKey;
  label: string;
  type: string;
  placeholder: string;
}> = [
  { key: "customerName", label: "Customer name", type: "text", placeholder: "Full name" },
  { key: "email", label: "Email", type: "email", placeholder: "customer@example.com" },
  { key: "phone", label: "Phone", type: "tel", placeholder: "+353…" },
  { key: "address", label: "Address / Eircode", type: "text", placeholder: "Address or Eircode" },
];

const emptyConfig: Config = {
  bridgeUrl: "",
  bridgeKey: "",
  apiVersion: "2026-04",
  boardId: "",
  groupId: "",
  columns: {},
  columnTypes: {},
};

const state: {
  records: LeadRecord[];
  config: Config;
  board: BoardDetails | null;
  settingsOpen: boolean;
  settingsMessage: string;
  toast: string;
  dragging: boolean;
  parsing: boolean;
  importingAll: boolean;
} = {
  records: [],
  config: loadConfig(),
  board: null,
  settingsOpen: false,
  settingsMessage: "",
  toast: "",
  dragging: false,
  parsing: false,
  importingAll: false,
};

const app = document.querySelector<HTMLDivElement>("#app")!;
const fileInput = document.querySelector<HTMLInputElement>("#mail-files")!;

function loadConfig(): Config {
  const defaults = window.MAIL_INTAKE_DEFAULTS ?? {};
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    // Hardcoded defaults remain usable when local file storage is unavailable.
  }
  const config = {
    ...emptyConfig,
    ...defaults,
    ...stored,
    columns: { ...(defaults.columns ?? {}), ...(stored.columns ?? {}) },
    columnTypes: {
      ...(defaults.columnTypes ?? {}),
      ...(stored.columnTypes ?? {}),
    },
  };
  return {
    ...config,
    bridgeUrl: defaults.bridgeUrl?.trim() || config.bridgeUrl,
    bridgeKey: defaults.bridgeKey?.trim() || config.bridgeKey,
    boardId: defaults.boardId?.trim() || config.boardId,
  };
}

function saveConfig(config: Config): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(config));
  } catch {
    throw new Error("Browser storage is blocked. Hardcode MAIL_INTAKE_DEFAULTS instead.");
  }
}

function importedItems(): Record<string, { id: string; url: string; at: string }> {
  try {
    return JSON.parse(localStorage.getItem(IMPORTED_KEY) || "{}");
  } catch {
    return {};
  }
}

function rememberImported(record: LeadRecord): void {
  if (!record.itemId || !record.itemUrl) return;
  const items = importedItems();
  items[record.duplicateKey] = {
    id: record.itemId,
    url: record.itemUrl,
    at: new Date().toISOString(),
  };
  const recent = Object.fromEntries(
    Object.entries(items)
      .sort((left, right) => right[1].at.localeCompare(left[1].at))
      .slice(0, 500),
  );
  try {
    localStorage.setItem(IMPORTED_KEY, JSON.stringify(recent));
  } catch {
    // Duplicate history is optional.
  }
}

function render(): void {
  const ready = state.records.filter((record) =>
    ["ready", "failed", "partial"].includes(record.status),
  ).length;
  app.innerHTML = `
    <header class="topbar">
      <div><strong>Mail intake</strong><span>Expert Windows</span></div>
      <button class="button quiet" data-action="settings">Settings</button>
    </header>
    <main>
      <section class="drop ${state.dragging ? "dragging" : ""}" data-action="browse" tabindex="0" role="button" aria-label="Choose email files">
        <strong>${state.parsing ? "Reading email files…" : "Drop EML or MSG files"}</strong>
        <span>${state.parsing ? "Please wait" : "or click to browse"}</span>
      </section>
      <div class="queue-bar">
        <div><h1>Import queue</h1><span>${state.records.length} submission${state.records.length === 1 ? "" : "s"} · clears on refresh</span></div>
        <div class="actions">
          ${state.records.length ? `<button class="button quiet danger" data-action="clear">Clear</button>` : ""}
          ${ready ? `<button class="button primary" data-action="import-all" ${state.importingAll ? "disabled" : ""}>${state.importingAll ? "Importing…" : `Import ${ready}`}</button>` : ""}
        </div>
      </div>
      ${state.records.length ? `<section class="records">${state.records.map(renderRecord).join("")}</section>` : `<section class="empty"><strong>No submissions</strong><span>Add an email file to begin.</span></section>`}
    </main>
    ${renderSettings()}
    ${state.toast ? `<div class="toast" role="alert">${escapeHtml(state.toast)}<button data-action="dismiss" aria-label="Dismiss">×</button></div>` : ""}
  `;
  if (state.settingsOpen) {
    document.querySelector<HTMLDialogElement>("#settings")?.showModal();
  }
}

function renderRecord(record: LeadRecord): string {
  const name = record.fields.customerName || record.fields.email || "Unnamed submission";
  const uploaded = record.attachments.filter((attachment) => attachment.status === "uploaded").length;
  return `
    <article class="record status-${record.status}" data-id="${record.id}">
      <button class="summary" data-action="toggle" data-id="${record.id}" aria-expanded="${record.open}">
        <span class="expand">${record.open ? "−" : "+"}</span>
        <span class="identity"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(record.fields.email || record.sourceName)}${record.fields.address ? ` · ${escapeHtml(record.fields.address)}` : ""}</small></span>
        <span class="lead-kind">${leadLabel(record.leadType)}</span>
        <span class="badge">${statusLabel(record.status)}</span>
      </button>
      ${record.open ? `
        <div class="record-body">
          ${record.error ? `<p class="notice error">${escapeHtml(record.error)}</p>` : ""}
          ${record.warnings.map((warning) => `<p class="notice warning">${escapeHtml(warning)}</p>`).join("")}
          ${renderDuplicate(record)}
          ${record.leadType === "email" ? renderGuidedReview(record) : ""}
          <div class="fields">
            ${field(record, "customerName", "Customer name")}
            ${field(record, "email", "Email", "email")}
            ${field(record, "phone", "Phone", "tel")}
            ${field(record, "address", "Address / Eircode")}
            ${field(record, "submittedAt", "Submitted", "datetime-local")}
            ${field(record, "formId", record.leadType === "palladio" ? "Quote ID" : "Form ID")}
            <label class="field full"><span>Message</span><textarea rows="7" data-record="${record.id}" data-field="message">${escapeHtml(record.fields.message)}</textarea></label>
          </div>
          <div class="files">
            <div class="section-line"><strong>Files</strong><span>${uploaded}/${record.attachments.length} uploaded</span></div>
            ${record.attachments.map((attachment) => renderAttachment(record, attachment)).join("")}
          </div>
          <div class="record-actions">
            <span>${escapeHtml(record.sourceName)}</span>
            <div class="actions">
              <button class="button quiet danger" data-action="delete" data-id="${record.id}" ${record.status === "importing" ? "disabled" : ""}>Delete</button>
              ${record.status === "complete" && record.itemUrl
                ? `<a class="button primary" href="${escapeAttribute(record.itemUrl)}" target="_blank" rel="noreferrer">Open in monday</a>`
                : `<button class="button primary" data-action="import" data-id="${record.id}" ${record.status === "importing" ? "disabled" : ""}>${record.status === "importing" ? "Working…" : record.itemId ? "Retry files" : "Import"}</button>`}
            </div>
          </div>
        </div>` : ""}
    </article>`;
}

function renderGuidedReview(record: LeadRecord): string {
  const missing = missingGuidedFields(record.fields);
  const descriptor = record.guideKey
    ? guidedFields.find((field) => field.key === record.guideKey)!
    : null;
  return `
    <div class="guided-review">
      <section class="guided-details">
        ${descriptor ? `
          <p>Missing contact details · ${missing.length} left</p>
          <label class="field"><span>${descriptor.label}</span><input data-guide="${record.id}" type="${descriptor.type}" placeholder="${escapeAttribute(descriptor.placeholder)}" value="${escapeAttribute(record.guideDraft)}"></label>
          <button class="button primary" data-action="guide-next" data-id="${record.id}">Save and continue</button>
        ` : `
          <p class="complete">Contact details complete</p>
          <strong>Ready to import</strong>
          <span>Name, email, phone, and address have been checked.</span>
        `}
      </section>
      <section class="email-preview">
        <div><span>Email preview</span><strong>${escapeHtml(record.subject)}</strong></div>
        <pre>${escapeHtml(record.emailPreview || record.fields.message)}</pre>
      </section>
    </div>`;
}

function renderDuplicate(record: LeadRecord): string {
  const match = importedItems()[record.duplicateKey];
  if (!match || record.itemId) return "";
  return `<p class="notice warning">Already imported. <a href="${escapeAttribute(match.url)}" target="_blank" rel="noreferrer">Open monday item</a></p>`;
}

function field(
  record: LeadRecord,
  key: keyof ParsedFields,
  label: string,
  type = "text",
): string {
  const value = key === "submittedAt" ? record.fields[key].slice(0, 16) : record.fields[key];
  return `<label class="field"><span>${label}</span><input type="${type}" value="${escapeAttribute(value)}" data-record="${record.id}" data-field="${key}"></label>`;
}

function renderAttachment(record: LeadRecord, attachment: AttachmentRecord): string {
  const detail = attachment.kind === "source" ? "Original email" : attachment.kind === "remote" ? "Form upload" : "Email attachment";
  return `
    <div class="file-row">
      <span class="file-name"><strong>${escapeHtml(attachment.name)}</strong><small>${detail}${attachment.size == null ? "" : ` · ${formatBytes(attachment.size)}`}</small></span>
      <span class="file-actions"><button class="link-button" data-action="download" data-id="${record.id}" data-attachment="${attachment.id}">Download</button><span class="file-status ${attachment.status}">${attachment.status}</span></span>
      ${attachment.error ? `<small class="file-error">${escapeHtml(attachment.error)}</small>` : ""}
    </div>`;
}

function renderSettings(): string {
  const config = state.config;
  const groups = state.board?.groups ?? [];
  const columns = state.board?.columns ?? [];
  return `
    <dialog id="settings">
      <form method="dialog" class="settings-form" id="settings-form">
        <div class="dialog-head"><div><strong>Settings</strong><span>Stored in this browser only.</span></div><button class="icon-button" value="cancel" data-action="close-settings" aria-label="Close">×</button></div>
        <label class="field full"><span>Upload bridge URL</span><input name="bridgeUrl" type="url" placeholder="https://mail-intake-bridge.example.workers.dev" value="${escapeAttribute(config.bridgeUrl)}"></label>
        <label class="field full"><span>Bridge access key</span><input name="bridgeKey" type="password" autocomplete="off" value="${escapeAttribute(config.bridgeKey)}"></label>
        <p class="settings-hint">The bridge handles monday file uploads and remote form files that browsers block. Its key is stored in this browser.</p>
        <div class="settings-grid">
          <label class="field"><span>Board ID</span><input name="boardId" value="${escapeAttribute(config.boardId)}"></label>
          <label class="field"><span>API version</span><input name="apiVersion" value="${escapeAttribute(config.apiVersion)}"></label>
        </div>
        <button class="button quiet full-button" type="button" data-action="test">Test and load board</button>
        ${state.board ? `
          <p class="board-name">${escapeHtml(state.board.name)}</p>
          <label class="field full"><span>Group</span><select name="groupId"><option value="">Choose group</option>${groups.map((group) => `<option value="${escapeAttribute(group.id)}" ${group.id === config.groupId ? "selected" : ""}>${escapeHtml(group.title)}</option>`).join("")}</select></label>
          <div class="mapping">
            ${mappingSelect("Email", "email", columns, ["email", "text", "long_text"])}
            ${mappingSelect("Phone", "phone", columns, ["phone", "text", "long_text"])}
            ${mappingSelect("Address", "address", columns, ["text", "long_text"])}
            ${mappingSelect("Message", "message", columns, ["long_text", "text"])}
            ${mappingSelect("Submitted", "submittedAt", columns, ["date"])}
            ${mappingSelect("Form / quote ID", "formId", columns, ["text", "long_text"])}
            ${mappingSelect("Files", "files", columns, ["file"])}
          </div>` : `
          <label class="field full"><span>Group ID</span><input name="groupId" value="${escapeAttribute(config.groupId)}"></label>
          <p class="settings-hint">Load the board to choose columns, or hardcode the IDs in MAIL_INTAKE_DEFAULTS.</p>`}
        ${state.settingsMessage ? `<p class="settings-message">${escapeHtml(state.settingsMessage)}</p>` : ""}
        <div class="dialog-actions"><button class="button quiet" value="cancel" data-action="close-settings">Cancel</button><button class="button primary" type="button" data-action="save-settings">Save</button></div>
      </form>
    </dialog>`;
}

function mappingSelect(
  label: string,
  key: ColumnKey,
  columns: BoardDetails["columns"],
  allowed: string[],
): string {
  return `<label><span>${label}</span><select name="column-${key}"><option value="">Do not import</option>${columns.filter((column) => allowed.includes(column.type)).map((column) => `<option value="${escapeAttribute(column.id)}" ${state.config.columns[key] === column.id ? "selected" : ""}>${escapeHtml(column.title)} · ${escapeHtml(column.type.replaceAll("_", " "))}</option>`).join("")}</select></label>`;
}

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  if (action === "browse") fileInput.click();
  if (action === "settings") {
    state.settingsOpen = true;
    state.settingsMessage = "";
    render();
  }
  if (action === "close-settings") {
    state.settingsOpen = false;
    render();
  }
  if (action === "dismiss") {
    state.toast = "";
    render();
  }
  if (action === "toggle" && id) {
    const record = findRecord(id);
    record.open = !record.open;
    render();
  }
  if (action === "guide-next" && id) saveGuidedField(findRecord(id));
  if (action === "delete" && id) deleteRecord(id);
  if (action === "clear") clearRecords();
  if (action === "import" && id) void importOne(id);
  if (action === "import-all") void importAll();
  if (action === "download" && id && target.dataset.attachment) {
    void downloadAttachment(id, target.dataset.attachment);
  }
  if (action === "test") void testAndLoadBoard();
  if (action === "save-settings") persistSettings();
});

app.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.dataset.guide) {
    findRecord(target.dataset.guide).guideDraft = target.value;
  }
});

app.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  const id = target.dataset.record;
  const key = target.dataset.field as keyof ParsedFields | undefined;
  if (!id || !key) return;
  const record = findRecord(id);
  record.fields[key] = target.value;
  if (record.leadType === "email" && !record.guideKey) {
    setNextGuide(record);
  }
});

app.addEventListener("keydown", (event) => {
  const browse = (event.target as HTMLElement).closest("[data-action='browse']");
  if (browse && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    fileInput.click();
  }
  const guide = (event.target as HTMLInputElement).dataset.guide;
  if (guide && event.key === "Enter") {
    event.preventDefault();
    saveGuidedField(findRecord(guide));
  }
});

for (const type of ["dragenter", "dragover"]) {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    state.dragging = true;
    document.querySelector(".drop")?.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    state.dragging = false;
    document.querySelector(".drop")?.classList.remove("dragging");
  });
}
document.addEventListener("drop", (event) => {
  void acceptFiles([...event.dataTransfer!.files]);
});
fileInput.addEventListener("change", () => {
  void acceptFiles([...(fileInput.files ?? [])]);
  fileInput.value = "";
});

async function acceptFiles(files: File[]): Promise<void> {
  const mailFiles = files.filter((file) => /\.(eml|msg)$/i.test(file.name));
  if (!mailFiles.length) return showError("Choose one or more EML or MSG files.");
  state.parsing = true;
  render();
  const failures: string[] = [];
  for (const file of mailFiles) {
    try {
      const record = await parseMailFile(file);
      const existing = state.records.findIndex((item) => item.duplicateKey === record.duplicateKey);
      if (existing >= 0) state.records[existing] = record;
      else state.records.unshift(record);
    } catch (error) {
      failures.push(`${file.name}: ${errorMessage(error)}`);
    }
  }
  state.parsing = false;
  if (failures.length) state.toast = failures.join(" ");
  render();
}

async function parseMailFile(file: File): Promise<LeadRecord> {
  const raw = await file.arrayBuffer();
  const hash = await sha256(raw);
  const isMsg = file.name.toLowerCase().endsWith(".msg") || hasOleHeader(raw);
  const email = isMsg
    ? parseMsg(raw)
    : ((await PostalMime.parse(raw)) as unknown as EmailLike);
  const htmlText = email.html ? htmlToText(email.html) : "";
  const lead = parseLeadContent({
    htmlText,
    plainText: email.text ?? "",
    subject: email.subject ?? "",
    date: email.date ?? "",
    sender: { name: email.from?.name, email: email.from?.address },
  });
  const duplicateKey = extractMessageKey(email) || hash;
  const attachments = extractAttachments(file, email.attachments ?? []);
  attachments.push(...extractRemoteFiles(email.html ?? "", email.text ?? "", attachments));
  const warnings = buildWarnings(lead.fields, lead.emailPreview, attachments);
  const guideKey = lead.leadType === "email" ? firstMissingGuidedField(lead.fields) : null;
  return {
    id: crypto.randomUUID(),
    duplicateKey,
    sourceName: file.name,
    subject: lead.subject,
    leadType: lead.leadType,
    emailPreview: lead.emailPreview,
    fields: lead.fields,
    warnings,
    attachments,
    status: "ready",
    error: null,
    itemId: null,
    itemUrl: null,
    open: true,
    guideKey,
    guideDraft: guideKey ? lead.fields[guideKey] : "",
  };
}

function parseMsg(raw: ArrayBuffer): EmailLike {
  const reader = createMsgReader(raw);
  const msg = reader.getFileData();
  return {
    subject: msg.subject,
    date: msg.clientSubmitTime || msg.messageDeliveryTime,
    messageId: msg.messageId,
    references: headerValue(msg.headers, "References"),
    inReplyTo: headerValue(msg.headers, "In-Reply-To"),
    html: stringValue(msg.html),
    text: msg.body || msg.preview || "",
    attachments: (msg.attachments ?? []).flatMap((descriptor: any) => {
      const attachment = reader.getAttachment(descriptor);
      if (!attachment?.content?.length) return [];
      const filename = attachment.fileName || descriptor.fileName || "attachment";
      const inline = Boolean(descriptor.attachmentHidden) || /^Outlook-[^.]+\.(?:png|jpe?g|gif)$/i.test(filename);
      return [{
        filename,
        mimeType: descriptor.attachMimeTag || "application/octet-stream",
        content: attachment.content,
        disposition: inline ? "inline" : "attachment",
        related: inline,
        contentId: descriptor.pidContentId,
      }];
    }),
  };
}

function createMsgReader(raw: ArrayBuffer): MsgReaderInstance {
  let candidate: unknown = MsgReaderModule;
  for (let depth = 0; depth < 2 && typeof candidate !== "function"; depth += 1) {
    candidate = (candidate as { default?: unknown } | null)?.default;
  }
  if (typeof candidate !== "function") {
    throw new Error("MSG reader could not be loaded.");
  }
  return new (candidate as MsgReaderConstructor)(raw);
}

function extractAttachments(
  sourceFile: File,
  source: NonNullable<EmailLike["attachments"]>,
): AttachmentRecord[] {
  const output: AttachmentRecord[] = [{
    id: crypto.randomUUID(),
    kind: "source",
    name: sourceFile.name,
    type: sourceFile.type || (sourceFile.name.toLowerCase().endsWith(".msg") ? "application/vnd.ms-outlook" : "message/rfc822"),
    size: sourceFile.size,
    blob: sourceFile,
    status: "ready",
    error: null,
  }];
  for (const attachment of source) {
    const name = sanitizeFilename(attachment.filename || "attachment");
    if (isBrandingAttachment(attachment, name)) continue;
    const bytes = Uint8Array.from(arrayBytes(attachment.content));
    const blob = new Blob([bytes.buffer], { type: attachment.mimeType || "application/octet-stream" });
    output.push({
      id: crypto.randomUUID(),
      kind: "mime",
      name,
      type: attachment.mimeType || "application/octet-stream",
      size: blob.size,
      blob,
      status: "ready",
      error: null,
    });
  }
  return output;
}

function isBrandingAttachment(
  attachment: NonNullable<EmailLike["attachments"]>[number],
  name: string,
): boolean {
  if (/^palladio-quote-.*-external\.png$/i.test(name)) return false;
  if (attachment.disposition === "attachment") return false;
  return (
    attachment.disposition === "inline" ||
    attachment.related === true ||
    Boolean(attachment.contentId) ||
    /^Outlook-[^.]+\.(?:png|jpe?g|gif)$/i.test(name)
  );
}

function extractRemoteFiles(
  html: string,
  text: string,
  existing: AttachmentRecord[],
): AttachmentRecord[] {
  const candidates = new Map<string, string>();
  const uploadPath = /\/(?:wp-content\/uploads\/)?wpforms\//i;
  if (html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const element of doc.querySelectorAll<HTMLAnchorElement | HTMLImageElement>("a[href], img[src]")) {
      const url = (element.getAttribute(element.tagName === "A" ? "href" : "src") || "").trim();
      if (!/^https?:\/\//i.test(url) || !uploadPath.test(url)) continue;
      const adjacent = element.tagName === "A" ? element.textContent?.trim() || "" : "";
      candidates.set(url, looksLikeFilename(adjacent) ? adjacent : filenameFromUrl(url));
    }
  }
  for (const match of `${text}\n${html}`.matchAll(/\[(https?:\/\/[^\]\s]+)]\s*([^<\r\n]*)/gi)) {
    const url = decodeEntities(match[1]);
    if (!uploadPath.test(url)) continue;
    const adjacent = decodeEntities(match[2]).trim();
    candidates.set(url, looksLikeFilename(adjacent) ? adjacent : filenameFromUrl(url));
  }
  const names = new Set(existing.map((attachment) => attachment.name));
  return [...candidates].map(([url, rawName]) => {
    const name = uniqueName(sanitizeFilename(rawName), names);
    return {
      id: crypto.randomUUID(),
      kind: "remote",
      name,
      type: inferMimeType(name),
      size: null,
      url,
      status: "ready",
      error: null,
    };
  });
}

function saveGuidedField(record: LeadRecord): void {
  if (!record.guideKey || !record.guideDraft.trim()) {
    showError("Enter this detail before continuing.");
    return;
  }
  record.fields[record.guideKey] = record.guideDraft.trim();
  setNextGuide(record);
  render();
}

function setNextGuide(record: LeadRecord): void {
  record.guideKey = firstMissingGuidedField(record.fields);
  record.guideDraft = record.guideKey ? record.fields[record.guideKey] : "";
}

function firstMissingGuidedField(fields: ParsedFields): GuidedKey | null {
  return guidedFields.find(({ key }) => !fields[key].trim())?.key ?? null;
}

function missingGuidedFields(fields: ParsedFields): GuidedKey[] {
  return guidedFields.filter(({ key }) => !fields[key].trim()).map(({ key }) => key);
}

async function testAndLoadBoard(): Promise<void> {
  try {
    const draft = readSettingsForm();
    if (!draft.bridgeUrl || !draft.bridgeKey || !draft.boardId) {
      throw new Error("Enter the upload bridge URL, access key, and board ID.");
    }
    state.config = draft;
    state.settingsMessage = "Connecting…";
    render();
    const result = await mondayRequest<{ me: { name: string }; boards: BoardDetails[] }>(
      `query ($ids: [ID!]) { me { name } boards(ids: $ids) { id name groups { id title } columns { id title type } } }`,
      { ids: [draft.boardId] },
      draft,
    );
    const board = result.boards[0];
    if (!board) throw new Error("Board not found or the token cannot access it.");
    state.board = board;
    state.config.groupId = board.groups.some((group) => group.id === state.config.groupId) ? state.config.groupId : board.groups[0]?.id ?? "";
    state.config.columnTypes = Object.fromEntries(board.columns.map((column) => [column.id, column.type]));
    state.config.columns = suggestMapping(board.columns, state.config.columns);
    state.settingsMessage = `Connected as ${result.me.name}.`;
  } catch (error) {
    state.settingsMessage = errorMessage(error);
  }
  state.settingsOpen = true;
  render();
}

function readSettingsForm(): Config {
  const form = document.querySelector<HTMLFormElement>("#settings-form")!;
  const data = new FormData(form);
  const columns: Config["columns"] = {};
  for (const key of ["email", "phone", "address", "message", "submittedAt", "formId", "files"] as ColumnKey[]) {
    const value = String(data.get(`column-${key}`) ?? state.config.columns[key] ?? "").trim();
    if (value) columns[key] = value;
  }
  return {
    ...state.config,
    bridgeUrl: String(data.get("bridgeUrl") ?? "").trim().replace(/\/+$/, ""),
    bridgeKey: String(data.get("bridgeKey") ?? "").trim(),
    apiVersion: String(data.get("apiVersion") ?? "2026-04").trim(),
    boardId: String(data.get("boardId") ?? "").trim(),
    groupId: String(data.get("groupId") ?? "").trim(),
    columns,
  };
}

function persistSettings(): void {
  try {
    const config = readSettingsForm();
    if (!config.bridgeUrl || !config.bridgeKey || !config.boardId || !config.groupId) {
      throw new Error("Bridge URL, bridge key, board ID, and group are required.");
    }
    saveConfig(config);
    state.config = config;
    state.settingsOpen = false;
    state.settingsMessage = "";
    render();
  } catch (error) {
    state.settingsMessage = errorMessage(error);
    state.settingsOpen = true;
    render();
  }
}

async function importAll(): Promise<void> {
  if (state.importingAll) return;
  state.importingAll = true;
  render();
  for (const record of state.records) {
    if (["ready", "failed", "partial"].includes(record.status)) await importRecord(record);
  }
  state.importingAll = false;
  render();
}

async function importOne(id: string): Promise<void> {
  await importRecord(findRecord(id));
  render();
}

async function importRecord(record: LeadRecord): Promise<void> {
  if (record.leadType === "email") {
    setNextGuide(record);
    if (record.guideKey) {
      record.open = true;
      state.toast = "Complete the missing contact details before importing this email.";
      render();
      return;
    }
  }
  if (!state.config.bridgeUrl || !state.config.bridgeKey || !state.config.boardId || !state.config.groupId) {
    state.settingsOpen = true;
    state.settingsMessage = "Add the bridge URL and key, then choose a monday board and group.";
    render();
    return;
  }
  record.status = "importing";
  record.error = null;
  render();
  try {
    if (!record.itemId) {
      const result = await mondayRequest<{ create_item: { id: string; url: string } }>(
        `mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) { create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) { id url } }`,
        {
          boardId: state.config.boardId,
          groupId: state.config.groupId,
          itemName: record.fields.customerName || record.fields.email || "Email submission",
          columnValues: JSON.stringify(buildColumnValues(record.fields)),
        },
      );
      record.itemId = result.create_item.id;
      record.itemUrl = result.create_item.url;
    }
    const filesColumn = state.config.columns.files;
    if (filesColumn) {
      let failures = 0;
      for (const attachment of record.attachments.filter((file) => file.status !== "uploaded")) {
        attachment.status = "uploading";
        attachment.error = null;
        render();
        try {
          await uploadAttachment(record.itemId!, filesColumn, attachment);
          attachment.status = "uploaded";
        } catch (error) {
          failures += 1;
          attachment.status = "failed";
          attachment.error = errorMessage(error);
        }
      }
      record.status = failures ? "partial" : "complete";
      record.error = failures ? `${failures} file${failures === 1 ? "" : "s"} could not be uploaded.` : null;
    } else {
      record.status = "complete";
    }
    rememberImported(record);
  } catch (error) {
    record.status = record.itemId ? "partial" : "failed";
    record.error = errorMessage(error);
  }
  render();
}

function buildColumnValues(fields: ParsedFields): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of ["email", "phone", "address", "message", "submittedAt", "formId"] as const) {
    const columnId = state.config.columns[key];
    const value = fields[key].trim();
    if (!columnId || !value) continue;
    const type = state.config.columnTypes[columnId] || "text";
    if (type === "email") values[columnId] = { email: value, text: value };
    else if (type === "phone") values[columnId] = normalizePhone(value);
    else if (type === "long_text") values[columnId] = { text: value };
    else if (type === "date") values[columnId] = mondayDate(value);
    else values[columnId] = value;
  }
  return values;
}

async function mondayRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
  config = state.config,
): Promise<T> {
  const response = await fetch(bridgeEndpoint("/monday/graphql", config), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.bridgeKey}`,
      "API-Version": config.apiVersion || "2026-04",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    errors?: Array<{ message?: string }>;
    error_message?: string;
  };
  if (!response.ok || payload.errors?.length || !payload.data) {
    throw new Error(payload.errors?.[0]?.message || payload.error_message || `monday request failed (${response.status}).`);
  }
  return payload.data;
}

async function uploadAttachment(
  itemId: string,
  columnId: string,
  attachment: AttachmentRecord,
): Promise<void> {
  if (attachment.size != null && attachment.size > MAX_REMOTE_BYTES) {
    throw new Error("File is larger than 25 MB.");
  }
  const form = new FormData();
  form.append("itemId", itemId);
  form.append("columnId", columnId);
  form.append("fileName", attachment.name);
  form.append("mimeType", attachment.type || "application/octet-stream");
  if (attachment.blob) form.append("file", attachment.blob, attachment.name);
  else if (attachment.url) form.append("sourceUrl", attachment.url);
  else throw new Error("File data is missing.");
  const response = await fetch(bridgeEndpoint("/monday/upload"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.config.bridgeKey}`,
      "API-Version": state.config.apiVersion || "2026-04",
    },
    body: form,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { add_file_to_column?: { id: string } };
    errors?: Array<{ message?: string }>;
    error_message?: string;
  };
  if (!response.ok || payload.errors?.length || !payload.data?.add_file_to_column) {
    throw new Error(payload.errors?.[0]?.message || payload.error_message || `File upload failed (${response.status}).`);
  }
}

async function downloadAttachment(recordId: string, attachmentId: string): Promise<void> {
  try {
    const attachment = findRecord(recordId).attachments.find((file) => file.id === attachmentId);
    if (!attachment) throw new Error("File not found.");
    if (attachment.url && !attachment.blob) {
      const anchor = document.createElement("a");
      anchor.href = attachment.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
      return;
    }
    if (!attachment.blob) throw new Error("File data is missing.");
    const url = URL.createObjectURL(attachment.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = attachment.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showError(errorMessage(error));
  }
}

function bridgeEndpoint(pathname: string, config = state.config): string {
  const base = config.bridgeUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("Upload bridge URL is not configured.");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Upload bridge URL is invalid.");
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Upload bridge must use HTTPS.");
  }
  return `${url.toString().replace(/\/$/, "")}${pathname}`;
}

function deleteRecord(id: string): void {
  const record = findRecord(id);
  if (!confirm(`Delete ${record.fields.customerName || record.sourceName} from this queue?`)) return;
  state.records = state.records.filter((item) => item.id !== id);
  render();
}

function clearRecords(): void {
  if (!confirm(`Clear ${state.records.length} submission${state.records.length === 1 ? "" : "s"}?`)) return;
  state.records = [];
  render();
}

function findRecord(id: string): LeadRecord {
  const record = state.records.find((item) => item.id === id);
  if (!record) throw new Error("Submission not found.");
  return record;
}

function suggestMapping(
  columns: BoardDetails["columns"],
  current: Config["columns"],
): Config["columns"] {
  const find = (types: string[], names: RegExp) =>
    columns.find((column) => types.includes(column.type) && names.test(column.title))?.id;
  return {
    email: current.email || find(["email", "text", "long_text"], /e-?mail/i),
    phone: current.phone || find(["phone", "text", "long_text"], /phone|mobile/i),
    address: current.address || find(["text", "long_text"], /address|eircode|area/i),
    message: current.message || find(["long_text", "text"], /message|enquiry|details|notes/i),
    submittedAt: current.submittedAt || find(["date"], /submitted|received|date/i),
    formId: current.formId || find(["text", "long_text"], /form|quote.*id|reference/i),
    files: current.files || find(["file"], /file|attachment|upload|photo/i),
  };
}

function buildWarnings(
  fields: ParsedFields,
  preview: string,
  attachments: AttachmentRecord[],
): string[] {
  const warnings: string[] = [];
  if (!fields.customerName) warnings.push("Customer name not found.");
  if (!fields.email) warnings.push("Customer email not found.");
  if (!fields.phone) warnings.push("Customer phone not found.");
  if (!fields.message) warnings.push("Message not found.");
  if (attachments.length === 1 && /\b(?:attach(?:ed|ment|ments)?|upload(?:ed|ing)?|files?|photos?)\b/i.test(preview)) {
    warnings.push("The email mentions files, but none were found.");
  }
  return warnings;
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, head").forEach((node) => node.remove());
  doc.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  doc.querySelectorAll("p, div, tr, li, blockquote, h1, h2, h3, td, th").forEach((node) => node.append("\n"));
  return doc.body.textContent || "";
}

function extractMessageKey(email: EmailLike): string {
  const source = email.references || email.inReplyTo || "";
  return [...source.matchAll(/<([^>]+)>/g)].at(-1)?.[1]?.trim() || (email.messageId || "").replace(/[<>]/g, "");
}

function hasOleHeader(raw: ArrayBuffer): boolean {
  const bytes = new Uint8Array(raw, 0, Math.min(raw.byteLength, 8));
  return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => bytes[index] === byte);
}

function headerValue(headers: string | undefined, name: string): string {
  return headers?.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim() || "";
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  return value == null ? "" : String(value);
}

function arrayBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array();
}

async function sha256(raw: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sanitizeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 180) || "attachment";
}

function uniqueName(raw: string, names: Set<string>): string {
  let name = raw;
  let index = 2;
  while (names.has(name)) {
    const dot = raw.lastIndexOf(".");
    name = dot > 0 ? `${raw.slice(0, dot)}-${index}${raw.slice(dot)}` : `${raw}-${index}`;
    index += 1;
  }
  names.add(name);
  return name;
}

function filenameFromUrl(value: string): string {
  try {
    return decodeURIComponent(new URL(value).pathname.split("/").pop() || "form-upload");
  } catch {
    return "form-upload";
  }
}

function looksLikeFilename(value: string): boolean {
  return /^[^<>]{1,180}\.[A-Za-z0-9]{2,10}$/.test(value);
}

function inferMimeType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() || "";
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } as Record<string, string>)[extension] || "application/octet-stream";
}

function decodeEntities(value: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function normalizePhone(value: string): { phone: string; countryShortName: string } {
  if (value.startsWith("00353")) return { phone: `+353${value.slice(5)}`, countryShortName: "IE" };
  if (value.startsWith("0")) return { phone: `+353${value.slice(1)}`, countryShortName: "IE" };
  return { phone: value, countryShortName: "IE" };
}

function mondayDate(value: string): unknown {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return value;
  const time = value.includes("T") ? value.split("T")[1]?.slice(0, 8) : "";
  return time ? { date, time: time.length === 5 ? `${time}:00` : time } : { date };
}

function leadLabel(type: LeadType): string {
  return { contact_form: "Contact form", palladio: "Palladio", email: "Email" }[type];
}

function statusLabel(status: LeadRecord["status"]): string {
  return { ready: "Ready", importing: "Importing", partial: "Retry files", complete: "Imported", failed: "Failed" }[status];
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showError(message: string): void {
  state.toast = message;
  render();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

render();
