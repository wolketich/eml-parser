import type {
  BoardDetails,
  BoardSummary,
  ImportOptions,
  ImportRecord,
  MondayConnectionStatus,
  MondayMapping,
  ParsedFields,
} from "../../../../packages/mail-parser/src/types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const hasBody = options?.body != null;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(hasBody && !(options?.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...options?.headers,
    },
  });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : {}) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

export async function listImports(): Promise<ImportRecord[]> {
  return (await request<{ imports: ImportRecord[] }>("/api/imports")).imports;
}

export function uploadEmlFiles(
  files: File[],
  onProgress: (percentage: number) => void,
): Promise<ImportRecord[]> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/parse");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      const body = JSON.parse(xhr.responseText || "{}") as {
        imports?: ImportRecord[];
        error?: string;
      };
      if (xhr.status >= 200 && xhr.status < 300 && body.imports) {
        resolve(body.imports);
      } else {
        reject(new Error(body.error || `Upload failed (${xhr.status}).`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("The upload could not be sent.")));
    xhr.send(form);
  });
}

export function deleteImport(id: string): Promise<void> {
  return request(`/api/imports/${id}`, { method: "DELETE" });
}

export function clearImports(): Promise<{ deleted: number }> {
  return request("/api/imports", { method: "DELETE" });
}

export function saveImportFields(
  id: string,
  fields: ParsedFields,
): Promise<ImportRecord> {
  return request(`/api/imports/${id}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

export function importRecord(
  id: string,
  options: ImportOptions = {},
): Promise<ImportRecord> {
  return request(`/api/import/${id}`, {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export function retryFiles(
  id: string,
  options: ImportOptions = {},
): Promise<ImportRecord> {
  return request(`/api/import/${id}/retry-files`, {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export function attachmentFileUrl(
  importId: string,
  attachmentId: string,
  download = false,
): string {
  const base = `/api/imports/${importId}/attachments/${attachmentId}/file`;
  return download ? `${base}?download=1` : base;
}

export function getMondayStatus(): Promise<MondayConnectionStatus> {
  return request("/api/monday/status");
}

export async function listBoards(): Promise<BoardSummary[]> {
  return (await request<{ boards: BoardSummary[] }>("/api/monday/boards")).boards;
}

export function getBoard(id: string): Promise<BoardDetails> {
  return request(`/api/monday/boards/${id}`);
}

export async function getMapping(): Promise<MondayMapping | null> {
  return (await request<{ mapping: MondayMapping | null }>("/api/settings/mapping"))
    .mapping;
}

export async function saveMapping(mapping: MondayMapping): Promise<MondayMapping> {
  return (
    await request<{ mapping: MondayMapping }>("/api/settings/mapping", {
      method: "PUT",
      body: JSON.stringify(mapping),
    })
  ).mapping;
}
