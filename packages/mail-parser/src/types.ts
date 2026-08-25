export const parsedFieldKeys = [
  "customerName",
  "email",
  "phone",
  "address",
  "message",
  "submittedAt",
  "formId",
] as const;

export type ParsedFieldKey = (typeof parsedFieldKeys)[number];

export type LeadType = "contact_form" | "palladio" | "email";

export type ImportStatus =
  | "parsed"
  | "importing"
  | "partial"
  | "complete"
  | "failed";

export type AttachmentStatus =
  | "pending"
  | "downloaded"
  | "uploaded"
  | "failed"
  | "ignored";

export interface ParsedFields {
  customerName: string;
  email: string;
  phone: string;
  address: string;
  message: string;
  submittedAt: string;
  formId: string;
}

export interface ImportAttachment {
  id: string;
  kind: "remote" | "mime" | "source";
  originalName: string;
  mimeType: string;
  sourceUrl: string | null;
  sizeBytes: number | null;
  status: AttachmentStatus;
  error: string | null;
  mondayAssetId: string | null;
  viewable: boolean;
  downloadable: boolean;
}

export interface ImportRecord {
  id: string;
  sourceName: string;
  subject: string;
  leadType: LeadType;
  emailPreview: string;
  fields: ParsedFields;
  warnings: string[];
  status: ImportStatus;
  duplicate: boolean;
  mondayItemId: string | null;
  mondayItemUrl: string | null;
  error: string | null;
  attachments: ImportAttachment[];
  createdAt: string;
  updatedAt: string;
}

export interface BoardSummary {
  id: string;
  name: string;
  workspaceName: string | null;
}

export interface BoardColumn {
  id: string;
  title: string;
  type: string;
}

export interface BoardGroup {
  id: string;
  title: string;
}

export interface BoardDetails {
  id: string;
  name: string;
  columns: BoardColumn[];
  groups: BoardGroup[];
}

export interface ColumnMapping {
  email?: string;
  phone?: string;
  address?: string;
  message?: string;
  submittedAt?: string;
  formId?: string;
  files?: string;
}

export interface MondayMapping {
  boardId: string;
  groupId: string;
  /** When false, imports create the monday item without uploading attachments. */
  uploadFiles?: boolean;
  columns: ColumnMapping;
}

export interface ImportOptions {
  uploadFiles?: boolean;
}

export interface MondayConnectionStatus {
  configured: boolean;
  connected: boolean;
  userName: string | null;
  error: string | null;
}
