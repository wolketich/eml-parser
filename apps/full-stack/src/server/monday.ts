import fs from "node:fs/promises";
import { ApiClient } from "@mondaydotcomorg/api";
import type {
  BoardDetails,
  BoardSummary,
  MondayConnectionStatus,
  MondayMapping,
  ParsedFields,
} from "../../../../packages/mail-parser/src/types.js";

interface MondayItem {
  id: string;
  url: string;
}

interface UploadedAsset {
  id: string;
  name: string;
  url: string;
}

export interface MondayGateway {
  testConnection(): Promise<MondayConnectionStatus>;
  listBoards(): Promise<BoardSummary[]>;
  getBoard(id: string): Promise<BoardDetails>;
  createItem(mapping: MondayMapping, fields: ParsedFields): Promise<MondayItem>;
  uploadFile(
    itemId: string,
    columnId: string,
    filePath: string,
    filename: string,
    mimeType: string,
  ): Promise<UploadedAsset>;
}

export const MONDAY_FILE_ENDPOINT = "https://api.monday.com/v2/file";

export class MondayClient implements MondayGateway {
  private readonly client: ApiClient | null;

  constructor(
    private readonly token: string,
    private readonly apiVersion: string,
  ) {
    this.client = token ? new ApiClient({ token, apiVersion }) : null;
  }

  async testConnection(): Promise<MondayConnectionStatus> {
    if (!this.client) {
      return {
        configured: false,
        connected: false,
        userName: null,
        error: "MONDAY_API_TOKEN is not configured.",
      };
    }
    try {
      const result = await this.withRetry<{ me: { name: string } }>(
        `query { me { name } }`,
      );
      return {
        configured: true,
        connected: true,
        userName: result.me.name,
        error: null,
      };
    } catch (error) {
      return {
        configured: true,
        connected: false,
        userName: null,
        error: errorMessage(error),
      };
    }
  }

  async listBoards(): Promise<BoardSummary[]> {
    const result = await this.withRetry<{
      boards: Array<{
        id: string;
        name: string;
        workspace: { name: string } | null;
      }>;
    }>(`
      query {
        boards(limit: 100) {
          id
          name
          workspace { name }
        }
      }
    `);
    return result.boards.map((board) => ({
      id: board.id,
      name: board.name,
      workspaceName: board.workspace?.name ?? null,
    }));
  }

  async getBoard(id: string): Promise<BoardDetails> {
    const result = await this.withRetry<{
      boards: Array<{
        id: string;
        name: string;
        columns: Array<{ id: string; title: string; type: string }>;
        groups: Array<{ id: string; title: string }>;
      }>;
    }>(
      `
        query ($ids: [ID!]) {
          boards(ids: $ids) {
            id
            name
            columns { id title type }
            groups { id title }
          }
        }
      `,
      { ids: [id] },
    );
    const board = result.boards[0];
    if (!board) throw new Error("The selected monday board was not found.");
    return board;
  }

  async createItem(
    mapping: MondayMapping,
    fields: ParsedFields,
  ): Promise<MondayItem> {
    const board = await this.getBoard(mapping.boardId);
    const columnTypes = Object.fromEntries(
      board.columns.map((column) => [column.id, column.type]),
    );
    const columnValues = buildColumnValues(mapping, fields, columnTypes);
    const result = await this.withRetry<{ create_item: MondayItem }>(
      `
        mutation (
          $boardId: ID!,
          $groupId: String!,
          $itemName: String!,
          $columnValues: JSON!
        ) {
          create_item(
            board_id: $boardId,
            group_id: $groupId,
            item_name: $itemName,
            column_values: $columnValues
          ) {
            id
            url
          }
        }
      `,
      {
        boardId: mapping.boardId,
        groupId: mapping.groupId,
        itemName: fields.customerName || fields.email || "Email submission",
        columnValues: JSON.stringify(columnValues),
      },
    );
    return result.create_item;
  }

  async uploadFile(
    itemId: string,
    columnId: string,
    filePath: string,
    filename: string,
    mimeType: string,
  ): Promise<UploadedAsset> {
    if (!this.token) throw new Error("MONDAY_API_TOKEN is not configured.");
    const content = await fs.readFile(filePath);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await uploadFileToColumn(
          this.token,
          this.apiVersion,
          itemId,
          columnId,
          filename,
          content,
          mimeType,
        );
      } catch (error) {
        lastError = error;
        if (attempt === 3 || !isRetryable(error)) break;
        await delay(retryDelay(error, attempt));
      }
    }
    throw new Error(errorMessage(lastError));
  }

  private async withRetry<T>(
    query: string,
    variables?: Record<string, unknown>,
    attempts = 3,
    timeoutMs = 20_000,
  ): Promise<T> {
    if (!this.client) throw new Error("MONDAY_API_TOKEN is not configured.");
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.client.request<T>(query, variables, {
          versionOverride: this.apiVersion,
          timeoutMs,
        });
      } catch (error) {
        lastError = error;
        if (attempt === attempts || !isRetryable(error)) break;
        await delay(retryDelay(error, attempt));
      }
    }
    throw new Error(errorMessage(lastError));
  }
}

export function buildColumnValues(
  mapping: MondayMapping,
  fields: ParsedFields,
  columnTypes: Record<string, string> = {},
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const columns = mapping.columns;

  setColumnValue(values, columns.email, columnTypes, fields.email, formatEmailValue);
  setColumnValue(values, columns.phone, columnTypes, fields.phone, formatPhoneValue);
  setColumnValue(values, columns.address, columnTypes, fields.address, formatTextValue);
  setColumnValue(values, columns.message, columnTypes, fields.message, formatTextValue);
  setColumnValue(values, columns.formId, columnTypes, fields.formId, formatTextValue);
  setColumnValue(
    values,
    columns.submittedAt,
    columnTypes,
    fields.submittedAt,
    formatDateValue,
  );

  return values;
}

function setColumnValue(
  values: Record<string, unknown>,
  columnId: string | undefined,
  columnTypes: Record<string, string>,
  rawValue: string,
  formatter: (value: string, columnType: string) => unknown,
): void {
  if (!columnId || !rawValue) return;
  const columnType = columnTypes[columnId] ?? "text";
  if (columnType === "file") return;
  values[columnId] = formatter(rawValue, columnType);
}

function formatEmailValue(value: string, columnType: string): unknown {
  if (columnType === "email") {
    return { email: value, text: value };
  }
  return formatTextValue(value, columnType);
}

function formatPhoneValue(value: string, columnType: string): unknown {
  if (columnType === "phone") {
    return normalizePhone(value);
  }
  return formatTextValue(value, columnType);
}

function formatTextValue(value: string, columnType: string): unknown {
  if (columnType === "long_text") {
    return { text: value };
  }
  return value;
}

export function buildFileUploadFormData(
  itemId: string,
  columnId: string,
  filename: string,
  content: Buffer,
  mimeType: string,
): FormData {
  const query = `
    mutation ($file: File!, $itemId: ID!, $columnId: String!) {
      add_file_to_column(
        file: $file,
        item_id: $itemId,
        column_id: $columnId
      ) {
        id
        name
        url
      }
    }
  `;
  const form = new FormData();
  form.append("query", query.trim());
  form.append(
    "variables",
    JSON.stringify({ itemId, columnId, file: null }),
  );
  form.append("map", JSON.stringify({ file: ["variables.file"] }));
  form.append(
    "file",
    new Blob([Uint8Array.from(content)], { type: mimeType }),
    filename,
  );
  return form;
}

export async function uploadFileToColumn(
  token: string,
  apiVersion: string,
  itemId: string,
  columnId: string,
  filename: string,
  content: Buffer,
  mimeType: string,
): Promise<UploadedAsset> {
  const form = buildFileUploadFormData(
    itemId,
    columnId,
    filename,
    content,
    mimeType,
  );
  const response = await fetch(MONDAY_FILE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: token,
      "API-Version": apiVersion,
    },
    body: form,
  });
  const payload = (await response.json()) as {
    data?: { add_file_to_column?: UploadedAsset };
    errors?: Array<{ message?: string }>;
    error_message?: string;
  };
  if (!response.ok) {
    throw new Error(
      payload.errors?.[0]?.message ??
        payload.error_message ??
        `monday.com file upload failed (${response.status}).`,
    );
  }
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message ?? "monday.com file upload failed.");
  }
  const asset = payload.data?.add_file_to_column;
  if (!asset) throw new Error("monday.com file upload returned no asset.");
  return asset;
}

function formatDateValue(value: string, columnType: string): unknown {
  if (columnType !== "date") return value;
  const trimmed = value.trim();
  const datePart = trimmed.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return value;
  const time = parseMondayTime(trimmed);
  return time ? { date: datePart, time } : { date: datePart };
}

function parseMondayTime(value: string): string | null {
  if (value.includes("T")) {
    const timePart = value.split("T")[1];
    return timePart ? normalizeMondayTime(timePart) : null;
  }
  const match = value.match(/\s+(\d{1,2}:\d{2}(?::\d{2})?)/);
  return match ? normalizeMondayTime(match[1]) : null;
}

function normalizeMondayTime(time: string): string {
  const [hours = "00", minutes = "00", seconds = "00"] = time.split(":");
  return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}:${seconds.padStart(2, "0")}`;
}

export function normalizePhone(
  phone: string,
): { phone: string; countryShortName: string } {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+353")) {
    return { phone: trimmed, countryShortName: "IE" };
  }
  if (trimmed.startsWith("00353")) {
    return { phone: `+353${trimmed.slice(5)}`, countryShortName: "IE" };
  }
  if (trimmed.startsWith("0")) {
    return { phone: `+353${trimmed.slice(1)}`, countryShortName: "IE" };
  }
  return { phone: trimmed, countryShortName: "IE" };
}

function isRetryable(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 429 || status >= 500;
}

function getErrorStatus(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const response = "response" in error ? error.response : null;
  if (!response || typeof response !== "object") return 0;
  return "status" in response && typeof response.status === "number"
    ? response.status
    : 0;
}

function retryDelay(error: unknown, attempt: number): number {
  if (error && typeof error === "object" && "response" in error) {
    const response = error.response;
    if (response && typeof response === "object" && "headers" in response) {
      const headers = response.headers;
      if (headers && typeof headers === "object") {
        const raw =
          "get" in headers && typeof headers.get === "function"
            ? headers.get("retry-after")
            : null;
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
      }
    }
  }
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

function graphqlErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  if ("response" in error) {
    const response = error.response;
    if (response && typeof response === "object") {
      if ("errors" in response) {
        const message = firstGraphqlMessage(response.errors);
        if (message) return message;
      }
      if ("error_message" in response && typeof response.error_message === "string") {
        return response.error_message;
      }
    }
  }
  if ("errors" in error) {
    return firstGraphqlMessage(error.errors);
  }
  return null;
}

function firstGraphqlMessage(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  if (!first || typeof first !== "object" || !("message" in first)) return null;
  return typeof first.message === "string" ? first.message : null;
}

function errorMessage(error: unknown): string {
  const graphqlMessage = graphqlErrorMessage(error);
  if (graphqlMessage) return graphqlMessage;
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "monday.com request failed.";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
