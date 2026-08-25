import { createHash } from "node:crypto";
import path from "node:path";
import { load } from "cheerio";
import PostalMime, { type Attachment, type Email } from "postal-mime";
import type { ParsedFields } from "../../../../packages/mail-parser/src/types.js";
import { parseLeadContent } from "../../../../packages/mail-parser/src/lead-parser.js";
import { filenameFromUrl, sanitizeFilename, uniqueFilename } from "./files.js";
import { isMsgSource, parseMsgToEmail } from "./msg.js";

export interface ParsedMimeAttachment {
  originalName: string;
  safeName: string;
  mimeType: string;
  content: Buffer;
}

export interface ParsedRemoteFile {
  originalName: string;
  safeName: string;
  mimeType: string;
  url: string;
}

export interface ParsedEml {
  hash: string;
  messageKey: string | null;
  subject: string;
  leadType: "contact_form" | "palladio" | "email";
  emailPreview: string;
  fields: ParsedFields;
  warnings: string[];
  mimeAttachments: ParsedMimeAttachment[];
  remoteFiles: ParsedRemoteFile[];
}

export async function parseEml(raw: Buffer, sourceName: string): Promise<ParsedEml> {
  return parseMessageContent(await PostalMime.parse(raw), raw);
}

export async function parseMail(raw: Buffer, sourceName: string): Promise<ParsedEml> {
  if (isMsgSource(raw, sourceName)) {
    return parseMessageContent(parseMsgToEmail(raw), raw);
  }
  return parseEml(raw, sourceName);
}

function parseMessageContent(email: Email, raw: Buffer): ParsedEml {
  const htmlText = email.html ? htmlToReadableText(email.html) : "";
  const plainText = email.text ?? "";
  const sender = email.from as { name?: string; address?: string } | undefined;
  const lead = parseLeadContent({
    htmlText,
    plainText,
    subject: email.subject ?? "",
    date: email.date ?? "",
    sender: { name: sender?.name, email: sender?.address },
  });
  const usedNames = new Set<string>();
  const mimeAttachments = extractMimeAttachments(email.attachments, usedNames);
  const remoteFiles = extractRemoteFiles(email, usedNames);
  const warnings = buildWarnings(lead.fields, lead.emailPreview, [
    ...mimeAttachments,
    ...remoteFiles,
  ]);

  return {
    hash: createHash("sha256").update(raw).digest("hex"),
    messageKey: extractMessageKey(email),
    subject: lead.subject,
    leadType: lead.leadType,
    emailPreview: lead.emailPreview,
    fields: lead.fields,
    warnings,
    mimeAttachments,
    remoteFiles,
  };
}

function htmlToReadableText(html: string): string {
  const $ = load(html);
  $("script, style, head").remove();
  $("br").replaceWith("\n");
  $("p, div, tr, li, blockquote, h1, h2, h3").each((_, element) => {
    $(element).append("\n");
  });
  $("td, th").each((_, element) => {
    $(element).append("\n");
  });
  return $.root().text();
}

function extractMessageKey(email: Email): string | null {
  const source = email.references || email.inReplyTo || "";
  const matches = [...source.matchAll(/<([^>]+)>/g)];
  return matches.at(-1)?.[1]?.trim() || email.messageId?.replace(/[<>]/g, "") || null;
}

function extractMimeAttachments(
  attachments: Attachment[],
  usedNames: Set<string>,
): ParsedMimeAttachment[] {
  return attachments.flatMap((attachment) => {
    if (isInlineBranding(attachment)) return [];
    if (!attachment.filename && attachment.disposition !== "attachment") return [];
    const originalName = sanitizeFilename(attachment.filename ?? "attachment");
    const safeName = uniqueFilename(originalName, usedNames);
    const content =
      typeof attachment.content === "string"
        ? Buffer.from(
            attachment.content,
            attachment.encoding === "base64" ? "base64" : "utf8",
          )
        : Buffer.from(
            attachment.content instanceof ArrayBuffer
              ? new Uint8Array(attachment.content)
              : attachment.content,
          );
    return [
      {
        originalName,
        safeName,
        mimeType: attachment.mimeType || "application/octet-stream",
        content,
      },
    ];
  });
}

function isInlineBranding(attachment: Attachment): boolean {
  const filename = attachment.filename ?? "";
  if (/^palladio-quote-.*-external\.png$/i.test(filename)) return false;
  if (attachment.disposition === "attachment") return false;
  return (
    attachment.disposition === "inline" ||
    attachment.related === true ||
    Boolean(attachment.contentId) ||
    /^Outlook-[^.]+\.(?:png|jpe?g|gif)$/i.test(filename)
  );
}

function extractRemoteFiles(email: Email, usedNames: Set<string>): ParsedRemoteFile[] {
  const candidates = new Map<string, { name: string; mimeType: string }>();
  const uploadPath = /\/(?:wp-content\/uploads\/)?wpforms\//i;

  if (email.html) {
    const $ = load(email.html);
    $("img[src], a[href]").each((_, element) => {
      const tag = element.tagName.toLowerCase();
      const url = $(element).attr(tag === "img" ? "src" : "href")?.trim();
      if (!url || !/^https?:\/\//i.test(url) || !uploadPath.test(url)) return;
      const adjacentName =
        tag === "a" ? $(element).text().trim() : $(element).next("a").text().trim();
      const name = looksLikeFilename(adjacentName)
        ? adjacentName
        : filenameFromUrl(url, "form-upload");
      candidates.set(url, { name, mimeType: inferMimeType(name) });
    });
  }

  const combinedText = `${email.text ?? ""}\n${email.html ?? ""}`;
  const bracketUrlPattern = /\[(https?:\/\/[^\]\s]+)]\s*([^<\r\n]*)/gi;
  for (const match of combinedText.matchAll(bracketUrlPattern)) {
    const url = decodeHtmlEntities(match[1]);
    if (!uploadPath.test(url)) continue;
    const possibleName = match[2].trim();
    const name = looksLikeFilename(possibleName)
      ? possibleName
      : filenameFromUrl(url, "form-upload");
    candidates.set(url, { name, mimeType: inferMimeType(name) });
  }

  return [...candidates.entries()].map(([url, candidate]) => ({
    url,
    originalName: sanitizeFilename(candidate.name),
    safeName: uniqueFilename(candidate.name, usedNames),
    mimeType: candidate.mimeType,
  }));
}

function looksLikeFilename(value: string): boolean {
  return /^[^<>]{1,180}\.[A-Za-z0-9]{2,10}$/.test(value);
}

function inferMimeType(name: string): string {
  const extension = path.extname(name).toLowerCase();
  return (
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".pdf": "application/pdf",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xls": "application/vnd.ms-excel",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }[extension] ?? "application/octet-stream"
  );
}

function decodeHtmlEntities(value: string): string {
  return load(`<span>${value}</span>`)("span").text();
}

function buildWarnings(
  fields: ParsedFields,
  submissionText: string,
  files: Array<unknown>,
): string[] {
  const warnings: string[] = [];
  if (!fields.customerName) warnings.push("Customer name was not found.");
  if (!fields.email) warnings.push("Customer email was not found.");
  if (!fields.phone) warnings.push("Customer phone was not found.");
  if (!fields.message) warnings.push("Submission message was not found.");
  if (
    files.length === 0 &&
    /\b(?:attach(?:ed|ment|ments)?|upload(?:ed|ing)?|files?)\b/i.test(submissionText)
  ) {
    warnings.push(
      "The message mentions files, but no downloadable customer files were found.",
    );
  }
  return warnings;
}
