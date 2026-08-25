import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  BoardColumn,
  BoardDetails,
  BoardSummary,
  ColumnMapping,
  ImportRecord,
  MondayConnectionStatus,
  MondayMapping,
  ParsedFieldKey,
  ParsedFields,
} from "../../../../packages/mail-parser/src/types";
import {
  attachmentFileUrl,
  clearImports,
  deleteImport,
  getBoard,
  getMapping,
  getMondayStatus,
  importRecord,
  listBoards,
  listImports,
  retryFiles,
  saveImportFields,
  saveMapping,
  uploadEmlFiles,
} from "./api";

type View = "imports" | "settings";
type GuidedFieldKey = "customerName" | "email" | "phone" | "address";

const guidedFields: Array<{
  key: GuidedFieldKey;
  label: string;
  type: string;
  placeholder: string;
}> = [
  { key: "customerName", label: "Customer name", type: "text", placeholder: "Full name" },
  { key: "email", label: "Email", type: "email", placeholder: "customer@example.com" },
  { key: "phone", label: "Phone", type: "tel", placeholder: "+353…" },
  { key: "address", label: "Address / Eircode", type: "text", placeholder: "Address or Eircode" },
];

export default function App() {
  const [view, setView] = useState<View>("imports");
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    listImports()
      .then(setImports)
      .catch((error: Error) => setToast(error.message))
      .finally(() => setLoading(false));
  }, []);

  function updateImport(updated: ImportRecord) {
    setImports((current) => {
      const exists = current.some((item) => item.id === updated.id);
      return exists
        ? current.map((item) => (item.id === updated.id ? updated : item))
        : [updated, ...current];
    });
  }

  function removeImport(id: string) {
    setImports((current) => current.filter((item) => item.id !== id));
  }

  function clearAllImports() {
    setImports([]);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView("imports")}>
          <img
            src="/expert-windows-logo.png"
            alt="Expert Windows"
            className="brand-logo"
          />
        </button>
        <nav aria-label="Main navigation">
          <button
            className={view === "imports" ? "active" : ""}
            onClick={() => setView("imports")}
          >
            Imports
          </button>
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
          >
            Settings
          </button>
        </nav>
      </header>

      <main>
        {view === "imports" ? (
          <ImportWorkspace
            imports={imports}
            loading={loading}
            onImports={(records) => {
              setImports((current) => {
                const next = [...current];
                for (const record of records) {
                  const index = next.findIndex((item) => item.id === record.id);
                  if (index >= 0) next[index] = record;
                  else next.unshift(record);
                }
                return next;
              });
            }}
            onUpdate={updateImport}
            onDelete={removeImport}
            onClearAll={clearAllImports}
            onError={setToast}
            onOpenSettings={() => setView("settings")}
          />
        ) : (
          <SettingsWorkspace onError={setToast} />
        )}
      </main>

      {toast && (
        <div className="toast" role="alert">
          <span>{toast}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function ImportWorkspace({
  imports,
  loading,
  onImports,
  onUpdate,
  onDelete,
  onClearAll,
  onError,
  onOpenSettings,
}: {
  imports: ImportRecord[];
  loading: boolean;
  onImports: (records: ImportRecord[]) => void;
  onUpdate: (record: ImportRecord) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onError: (message: string) => void;
  onOpenSettings: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [batching, setBatching] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [hideImported, setHideImported] = useState(false);
  const [uploadFiles, setUploadFiles] = useState(true);
  const [dropOpen, setDropOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getMapping()
      .then((mapping) => setUploadFiles(mapping?.uploadFiles ?? true))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (imports.length === 0) setDropOpen(true);
  }, [imports.length]);
  const ready = imports.filter((item) =>
    ["parsed", "failed", "partial"].includes(item.status),
  );
  const importedCount = imports.filter((item) => item.status === "complete").length;
  const visibleImports = hideImported
    ? imports.filter((item) => item.status !== "complete")
    : imports;

  async function acceptFiles(files: File[]) {
    const mailFiles = files.filter((file) => /\.(eml|msg)$/i.test(file.name));
    if (!mailFiles.length) {
      onError("Choose one or more .eml or .msg files.");
      return;
    }
    setUploading(true);
    setProgress(0);
    try {
      onImports(await uploadEmlFiles(mailFiles, setProgress));
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  async function importReady() {
    setBatching(true);
    try {
      for (const item of ready) {
        if (item.status === "partial") {
          onUpdate(await retryFiles(item.id, { uploadFiles }));
        } else {
          onUpdate(await importRecord(item.id, { uploadFiles }));
        }
      }
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBatching(false);
    }
  }

  async function clearQueue() {
    if (
      !window.confirm(
        `Clear all ${imports.length} submission${imports.length === 1 ? "" : "s"} from the queue? This removes them from this app only. It does not delete monday items.`,
      )
    ) {
      return;
    }
    setClearing(true);
    try {
      await clearImports();
      onClearAll();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setClearing(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void acceptFiles([...event.dataTransfer.files]);
  }

  return (
    <section className="workspace">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Expert Windows · Mail intake</p>
          <h1>Review form enquiries before they reach monday.</h1>
          <p>
            Drop forwarded EML or MSG files, check customer details and form uploads, then
            import into your board.
          </p>
        </div>
        <button className="text-action" onClick={onOpenSettings}>
          Board mapping <ArrowIcon />
        </button>
      </div>

      <section className={`drop-panel ${dropOpen ? "open" : "collapsed"}`}>
        <button
          type="button"
          className="drop-panel-toggle"
          onClick={() => setDropOpen((open) => !open)}
          aria-expanded={dropOpen}
        >
          <span className="drop-toggle-label">
            <UploadIcon />
            Add email submissions
          </span>
          <ChevronIcon open={dropOpen} />
        </button>
        {dropOpen && (
          <div
            className={`drop-zone ${dragging ? "dragging" : ""} ${uploading ? "uploading" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setDragging(false);
              }
            }}
            onDrop={handleDrop}
            onClick={() => !uploading && inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
            }}
          >
            <input
              ref={inputRef}
              hidden
              type="file"
              accept=".eml,.msg,message/rfc822,application/vnd.ms-outlook"
              multiple
              onChange={(event) => {
                void acceptFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
            <span className="drop-icon">
              <UploadIcon />
            </span>
            <div className="drop-copy">
              <strong>
                {uploading
                  ? `Reading email files ${progress}%`
                  : dragging
                    ? "Release to add these emails"
                    : "Drop EML or MSG files here"}
              </strong>
              <span>
                {uploading
                  ? "Extracting messages and attachments"
                  : "or click to browse your computer"}
              </span>
            </div>
            {uploading && (
              <span className="progress-track">
                <span style={{ width: `${progress}%` }} />
              </span>
            )}
          </div>
        )}
      </section>

      <div className="queue-heading">
        <div>
          <h2>Import queue</h2>
          <span>
            {hideImported && importedCount > 0
              ? `${visibleImports.length} shown · ${imports.length} total`
              : `${imports.length} saved submission${imports.length === 1 ? "" : "s"}`}
          </span>
        </div>
        {imports.length > 0 && (
          <div className="queue-actions">
            {importedCount > 0 && (
              <label className="import-toggle">
                <input
                  type="checkbox"
                  checked={hideImported}
                  onChange={(event) => setHideImported(event.target.checked)}
                />
                Hide imported
              </label>
            )}
            {ready.length > 0 && (
              <label className="import-toggle">
                <input
                  type="checkbox"
                  checked={uploadFiles}
                  onChange={(event) => setUploadFiles(event.target.checked)}
                />
                Upload files to monday
              </label>
            )}
            {ready.length > 0 && (
              <button className="primary-button" onClick={importReady} disabled={batching || clearing}>
                {batching ? "Importing queue…" : `Import ${ready.length} ready`}
              </button>
            )}
            <button
              className="secondary-button danger-button"
              onClick={clearQueue}
              disabled={batching || clearing}
            >
              {clearing ? "Clearing…" : "Clear queue"}
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="empty-state">Loading saved submissions…</div>
      ) : imports.length === 0 ? (
        <div className="empty-state">
          <MailIcon />
          <strong>No submissions yet</strong>
          <span>Your parsed email enquiries will appear here.</span>
        </div>
      ) : visibleImports.length === 0 ? (
        <div className="empty-state">
          <MailIcon />
          <strong>All submissions are imported</strong>
          <span>Uncheck &ldquo;Hide imported&rdquo; above to review completed items.</span>
        </div>
      ) : (
        <div className="review-list">
          {visibleImports.map((item) => (
            <ReviewRow
              key={item.id}
              item={item}
              defaultUploadFiles={uploadFiles}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onError={onError}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ReviewRow({
  item,
  defaultUploadFiles,
  onUpdate,
  onDelete,
  onError,
}: {
  item: ImportRecord;
  defaultUploadFiles: boolean;
  onUpdate: (record: ImportRecord) => void;
  onDelete: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(item.status !== "complete");
  const [fields, setFields] = useState(item.fields);
  const [working, setWorking] = useState(false);
  const [uploadFiles, setUploadFiles] = useState(defaultUploadFiles);
  const initialGuide = firstMissingGuidedField(item.fields);
  const [guideKey, setGuideKey] = useState<GuidedFieldKey | null>(initialGuide);
  const [guideValue, setGuideValue] = useState(
    initialGuide ? item.fields[initialGuide] : "",
  );

  useEffect(() => setFields(item.fields), [item.fields]);
  useEffect(() => setUploadFiles(defaultUploadFiles), [defaultUploadFiles]);

  useEffect(() => {
    if (item.leadType !== "email" || guideKey !== null) return;
    const next = firstMissingGuidedField(fields);
    if (next) {
      setGuideKey(next);
      setGuideValue(fields[next]);
    }
  }, [fields, guideKey, item.leadType]);

  function saveGuidedField() {
    if (!guideKey || !guideValue.trim()) return;
    const nextFields = { ...fields, [guideKey]: guideValue.trim() };
    setFields(nextFields);
    const next = firstMissingGuidedField(nextFields);
    setGuideKey(next);
    setGuideValue(next ? nextFields[next] : "");
  }

  async function performImport() {
    if (item.leadType === "email") {
      const missing = firstMissingGuidedField(fields);
      if (missing) {
        setGuideKey(missing);
        setGuideValue(fields[missing]);
        onError("Complete the missing contact details before importing this email.");
        return;
      }
    }
    setWorking(true);
    try {
      const saved = await saveImportFields(item.id, fields);
      onUpdate(
        item.status === "partial"
          ? await retryFiles(saved.id, { uploadFiles })
          : await importRecord(saved.id, { uploadFiles }),
      );
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function performDelete() {
    const label = item.fields.customerName || item.fields.email || item.sourceName;
    if (
      !window.confirm(
        `Delete "${label}" from the queue? This removes the submission and its files from this app. It does not delete the monday item.`,
      )
    ) {
      return;
    }
    setWorking(true);
    try {
      await deleteImport(item.id);
      onDelete(item.id);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  const failedFiles = item.attachments.filter((file) => file.status === "failed").length;
  const uploadedFiles = item.attachments.filter(
    (file) => file.status === "uploaded",
  ).length;

  return (
    <article className={`review-row status-${item.status}`}>
      <button className="review-summary" onClick={() => setOpen((value) => !value)}>
        <span className="expand-icon">{open ? "−" : "+"}</span>
        <span className="identity">
          <strong>{item.fields.customerName || "Unnamed submission"}</strong>
          <small>
            {item.fields.email || item.sourceName}
            {item.fields.address ? ` · ${item.fields.address}` : ""}
          </small>
        </span>
        <span className="file-count">
          <PaperclipIcon />
          {item.attachments.length}
        </span>
        <StatusBadge status={item.status} />
      </button>

      {open && (
        <div className="review-body">
          {item.duplicate && (
            <Notice tone="info">
              This email was already added to the queue.
              {item.mondayItemUrl && (
                <a href={item.mondayItemUrl} target="_blank" rel="noreferrer">
                  Open the existing monday item
                </a>
              )}
            </Notice>
          )}
          {item.warnings.map((warning) => (
            <Notice key={warning} tone="warning">
              {warning}
            </Notice>
          ))}
          {item.error && <Notice tone="error">{item.error}</Notice>}

          {item.leadType === "email" && (
            <div className="guided-email-review">
              <section className="guided-details" aria-live="polite">
                {guideKey ? (
                  <>
                    <p className="guided-step">
                      Missing contact details · {guidedFields.filter(({ key }) => !fields[key].trim()).length} left
                    </p>
                    <label className="field">
                      <span>{guidedField(guideKey).label}</span>
                      <input
                        autoFocus
                        type={guidedField(guideKey).type}
                        placeholder={guidedField(guideKey).placeholder}
                        value={guideValue}
                        onChange={(event) => setGuideValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            saveGuidedField();
                          }
                        }}
                      />
                    </label>
                    <button
                      className="primary-button"
                      onClick={saveGuidedField}
                      disabled={!guideValue.trim()}
                    >
                      Save and continue <ArrowIcon />
                    </button>
                  </>
                ) : (
                  <>
                    <p className="guided-step complete">Contact details complete</p>
                    <strong>Ready to import</strong>
                    <span>Name, email, phone, and address have been checked.</span>
                  </>
                )}
              </section>
              <section className="email-preview" aria-label="Email preview">
                <div>
                  <span>Email preview</span>
                  <strong>{item.subject}</strong>
                </div>
                <pre>{item.emailPreview || item.fields.message}</pre>
              </section>
            </div>
          )}

          <div className="form-grid">
            <Field
              label="Customer name"
              value={fields.customerName}
              onChange={(value) => setFields({ ...fields, customerName: value })}
            />
            <Field
              label="Email"
              value={fields.email}
              type="email"
              onChange={(value) => setFields({ ...fields, email: value })}
            />
            <Field
              label="Phone"
              value={fields.phone}
              onChange={(value) => setFields({ ...fields, phone: value })}
            />
            <Field
              label="Address / Eircode"
              value={fields.address}
              onChange={(value) => setFields({ ...fields, address: value })}
            />
            <Field
              label="Submitted"
              value={toDateTimeLocal(fields.submittedAt)}
              type="datetime-local"
              onChange={(value) => setFields({ ...fields, submittedAt: value })}
            />
            <Field
              label="Form ID"
              value={fields.formId}
              onChange={(value) => setFields({ ...fields, formId: value })}
            />
            <label className="field full-width">
              <span>Message</span>
              <textarea
                value={fields.message}
                rows={6}
                onChange={(event) =>
                  setFields({ ...fields, message: event.target.value })
                }
              />
            </label>
          </div>

          <div className="attachments">
            <div className="section-label">
              <span>Files</span>
              <small>
                {uploadedFiles} uploaded
                {failedFiles ? ` · ${failedFiles} failed` : ""}
              </small>
            </div>
            {item.attachments.map((attachment) => (
              <div className="attachment-row" key={attachment.id}>
                <FileIcon />
                <span>
                  <strong>{attachment.originalName}</strong>
                  <small>
                    {attachment.kind === "source"
                      ? "Original email"
                      : attachment.kind === "remote"
                        ? "Form upload"
                        : "Email attachment"}
                    {attachment.sizeBytes
                      ? ` · ${formatBytes(attachment.sizeBytes)}`
                      : ""}
                  </small>
                </span>
                <span className="attachment-actions">
                  {attachment.viewable && (
                    <a
                      className="secondary-button attachment-view"
                      href={attachmentFileUrl(item.id, attachment.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View
                    </a>
                  )}
                  {attachment.downloadable && (
                    <a
                      className="secondary-button attachment-view"
                      href={attachmentFileUrl(item.id, attachment.id, true)}
                      download={attachment.originalName}
                    >
                      Download
                    </a>
                  )}
                  <span className={`attachment-status ${attachment.status}`}>
                    {attachment.status}
                  </span>
                </span>
                {attachment.error && (
                  <small className="attachment-error">{attachment.error}</small>
                )}
              </div>
            ))}
          </div>

          <div className="review-actions">
            <span>
              Source: {item.sourceName}
              {item.status !== "partial" && (
                <label className="import-toggle inline">
                  <input
                    type="checkbox"
                    checked={uploadFiles}
                    onChange={(event) => setUploadFiles(event.target.checked)}
                    disabled={working || item.status === "importing"}
                  />
                  Upload files to monday
                </label>
              )}
            </span>
            <span className="review-action-buttons">
              <button
                className="secondary-button danger-button"
                onClick={performDelete}
                disabled={working || item.status === "importing"}
              >
                Delete
              </button>
              {item.status === "complete" && item.mondayItemUrl ? (
                <a
                  className="primary-button"
                  href={item.mondayItemUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in monday <ArrowIcon />
                </a>
              ) : (
                <button
                  className="primary-button"
                  onClick={performImport}
                  disabled={working || item.status === "importing"}
                >
                  {working || item.status === "importing"
                    ? "Working…"
                    : item.status === "partial"
                      ? "Retry files"
                      : "Import to monday"}
                </button>
              )}
            </span>
          </div>
        </div>
      )}
    </article>
  );
}

function SettingsWorkspace({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<MondayConnectionStatus | null>(null);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [board, setBoard] = useState<BoardDetails | null>(null);
  const [mapping, setMapping] = useState<MondayMapping>({
    boardId: "",
    groupId: "",
    uploadFiles: true,
    columns: {},
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function loadConnection() {
    try {
      const connection = await getMondayStatus();
      setStatus(connection);
      if (connection.connected) setBoards(await listBoards());
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  useEffect(() => {
    void Promise.all([loadConnection(), getMapping()]).then(([, stored]) => {
      if (stored) setMapping(stored);
    });
  }, []);

  useEffect(() => {
    if (!mapping.boardId || !status?.connected) {
      setBoard(null);
      return;
    }
    getBoard(mapping.boardId)
      .then((details) => {
        setBoard(details);
        setMapping((current) => ({
          ...current,
          groupId:
            current.groupId && details.groups.some((group) => group.id === current.groupId)
              ? current.groupId
              : details.groups[0]?.id ?? "",
          columns:
            Object.keys(current.columns).length > 0
              ? current.columns
              : suggestMapping(details.columns),
        }));
      })
      .catch((error: Error) => onError(error.message));
  }, [mapping.boardId, status?.connected]);

  async function persist() {
    setSaving(true);
    setSaved(false);
    try {
      setMapping(await saveMapping(mapping));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="workspace settings-workspace">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Destination settings</p>
          <h1>Choose where each submission should go.</h1>
          <p>
            The API token stays in your local environment. This screen stores only
            the selected board, group, and column IDs.
          </p>
        </div>
      </div>

      <section className="settings-section">
        <div className="settings-copy">
          <span className="step-number">01</span>
          <div>
            <h2>monday connection</h2>
            <p>
              Set <code>MONDAY_API_TOKEN</code> in <code>.env</code>, then restart
              the service.
            </p>
          </div>
        </div>
        <div className="connection-line">
          <span
            className={`connection-indicator ${status?.connected ? "connected" : ""}`}
          />
          <span>
            <strong>
              {status?.connected
                ? `Connected as ${status.userName}`
                : status?.configured
                  ? "Token could not connect"
                  : "Token not configured"}
            </strong>
            <small>{status?.error || "monday API is available."}</small>
          </span>
          <button className="secondary-button" onClick={loadConnection}>
            Test connection
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-copy">
          <span className="step-number">02</span>
          <div>
            <h2>Board and group</h2>
            <p>Select the destination for every imported enquiry.</p>
          </div>
        </div>
        <div className="settings-controls two-column">
          <SelectField
            label="Board"
            value={mapping.boardId}
            disabled={!status?.connected}
            onChange={(value) =>
              setMapping({ boardId: value, groupId: "", columns: {} })
            }
            options={boards.map((item) => ({
              value: item.id,
              label: item.workspaceName
                ? `${item.name} · ${item.workspaceName}`
                : item.name,
            }))}
            placeholder="Choose a board"
          />
          <SelectField
            label="Group"
            value={mapping.groupId}
            disabled={!board}
            onChange={(value) => setMapping({ ...mapping, groupId: value })}
            options={(board?.groups ?? []).map((group) => ({
              value: group.id,
              label: group.title,
            }))}
            placeholder="Choose a group"
          />
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-copy">
          <span className="step-number">03</span>
          <div>
            <h2>Column mapping</h2>
            <p>Match email fields to compatible columns on the selected board.</p>
          </div>
        </div>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={mapping.uploadFiles ?? true}
            onChange={(event) =>
              setMapping({ ...mapping, uploadFiles: event.target.checked })
            }
          />
          Upload files to monday when importing
        </label>
        <div className="mapping-list">
          <MappingRow
            label="Customer name"
            hint="monday item name"
            fixed="Item name"
          />
          <MappingRow
            label="Email"
            field="email"
            value={mapping.columns.email}
            columns={compatibleColumns(board?.columns, ["email", "text", "long_text"])}
            onChange={(value) => updateColumn(setMapping, "email", value)}
          />
          <MappingRow
            label="Phone"
            field="phone"
            value={mapping.columns.phone}
            columns={compatibleColumns(board?.columns, ["phone", "text", "long_text"])}
            onChange={(value) => updateColumn(setMapping, "phone", value)}
          />
          <MappingRow
            label="Address / Eircode"
            field="address"
            value={mapping.columns.address}
            columns={compatibleColumns(board?.columns, ["text", "long_text"])}
            onChange={(value) => updateColumn(setMapping, "address", value)}
          />
          <MappingRow
            label="Message"
            field="message"
            value={mapping.columns.message}
            columns={compatibleColumns(board?.columns, ["long_text", "text"])}
            onChange={(value) => updateColumn(setMapping, "message", value)}
          />
          <MappingRow
            label="Submitted date"
            field="submittedAt"
            value={mapping.columns.submittedAt}
            columns={compatibleColumns(board?.columns, ["date"])}
            onChange={(value) => updateColumn(setMapping, "submittedAt", value)}
          />
          <MappingRow
            label="Form ID"
            field="formId"
            value={mapping.columns.formId}
            columns={compatibleColumns(board?.columns, ["text", "long_text"])}
            onChange={(value) => updateColumn(setMapping, "formId", value)}
          />
          <MappingRow
            label="All files"
            field="files"
            required={mapping.uploadFiles ?? true}
            value={mapping.columns.files}
            columns={compatibleColumns(board?.columns, ["file"])}
            onChange={(value) => updateColumn(setMapping, "files", value)}
          />
        </div>
      </section>

      <div className="settings-footer">
        <span>{saved ? "Mapping saved." : "Changes apply to future imports."}</span>
        <button
          className="primary-button"
          onClick={persist}
          disabled={
            saving ||
            !mapping.boardId ||
            !mapping.groupId ||
            ((mapping.uploadFiles ?? true) && !mapping.columns.files)
          }
        >
          {saving ? "Saving…" : "Save mapping"}
        </button>
      </div>
    </section>
  );
}

function MappingRow({
  label,
  value,
  columns = [],
  fixed,
  required,
  onChange,
}: {
  label: string;
  field?: keyof ColumnMapping;
  value?: string;
  columns?: BoardColumn[];
  fixed?: string;
  hint?: string;
  required?: boolean;
  onChange?: (value: string) => void;
}) {
  return (
    <div className="mapping-row">
      <span>
        {label}
        {required && <em>Required</em>}
      </span>
      <ArrowIcon />
      {fixed ? (
        <span className="fixed-mapping">{fixed}</span>
      ) : (
        <select value={value ?? ""} onChange={(event) => onChange?.(event.target.value)}>
          <option value="">{required ? "Choose a Files column" : "Do not import"}</option>
          {columns.map((column) => (
            <option value={column.id} key={column.id}>
              {column.title} · {column.type.replace("_", " ")}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function updateColumn(
  setter: React.Dispatch<React.SetStateAction<MondayMapping>>,
  key: keyof ColumnMapping,
  value: string,
) {
  setter((current) => ({
    ...current,
    columns: { ...current.columns, [key]: value || undefined },
  }));
}

function compatibleColumns(
  columns: BoardColumn[] | undefined,
  types: string[],
): BoardColumn[] {
  return (columns ?? []).filter((column) => types.includes(column.type));
}

function suggestMapping(columns: BoardColumn[]): ColumnMapping {
  const find = (types: string[], names: RegExp) =>
    columns.find((column) => types.includes(column.type) && names.test(column.title))
      ?.id;
  return {
    email:
      find(["email"], /e-?mail/i) ?? find(["text", "long_text"], /e-?mail/i),
    phone:
      find(["phone"], /phone|mobile/i) ??
      find(["text", "long_text"], /phone|mobile/i),
    address: find(["text", "long_text"], /address|eircode|area/i),
    message: find(["long_text", "text"], /message|enquiry|details|notes/i),
    submittedAt: find(["date"], /submitted|received|date/i),
    formId: find(["text", "long_text"], /form.*id/i),
    files: find(["file"], /file|attachment|upload|photo/i),
  };
}

function firstMissingGuidedField(fields: ParsedFields): GuidedFieldKey | null {
  return guidedFields.find(({ key }) => !fields[key].trim())?.key ?? null;
}

function guidedField(key: GuidedFieldKey) {
  return guidedFields.find((field) => field.key === key)!;
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "warning" | "error" | "info";
  children: ReactNode;
}) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

function StatusBadge({ status }: { status: ImportRecord["status"] }) {
  const label = {
    parsed: "Ready",
    importing: "Importing",
    partial: "Needs retry",
    complete: "Imported",
    failed: "Failed",
  }[status];
  return <span className={`status-badge ${status}`}>{label}</span>;
}

function toDateTimeLocal(value: string): string {
  return value ? value.slice(0, 16) : "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 5l5 5-5 5" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v4h14v-4" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m7 10 5-5a3 3 0 0 1 4 4l-7 7a5 5 0 0 1-7-7l7-7" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 2h6l4 4v12H5z" />
      <path d="M11 2v5h4" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`chevron-icon ${open ? "open" : ""}`}
      viewBox="0 0 20 20"
      aria-hidden="true"
    >
      <path d="m5 8 5 5 5-5" />
    </svg>
  );
}
