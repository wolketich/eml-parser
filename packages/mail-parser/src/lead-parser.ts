import type { LeadType, ParsedFields } from "./types.js";

export interface LeadParseInput {
  htmlText: string;
  plainText: string;
  subject: string;
  date: string;
  sender?: { name?: string; email?: string };
}

export interface ParsedLeadContent {
  leadType: LeadType;
  subject: string;
  emailPreview: string;
  fields: ParsedFields;
}

const formLabels = [
  "Name",
  "Email",
  "Phone",
  "Address (EIR code/area)",
  "Address",
  "Message",
  "Upload pictures of your window/door or preferred style (optional)",
] as const;

const formLabelLookup = new Set(formLabels.map(normalizeLabel));

const palladioLabels = [
  "Frame Type",
  "External frame colour",
  "Internal frame colour",
  "Door style",
  "External door colour",
  "Internal door colour",
  "Furniture colour",
  "Door handle",
  "Door pull handle",
  "Decorative Door Knob",
  "Letterplate",
  "Knocker",
  "Glazing",
  "Backing Glass",
] as const;

const palladioContactLabels = [
  { key: "customerName", labels: ["Name", "Customer Name"] },
  { key: "email", labels: ["Email", "Email Address"] },
  { key: "phone", labels: ["Phone", "Phone Number", "Mobile"] },
  { key: "address", labels: ["Address", "Eircode", "Address / Eircode"] },
] as const;

export function parseLeadContent(input: LeadParseInput): ParsedLeadContent {
  const selectedText = normalizeTextCharacters(
    chooseLeadText(input.htmlText, input.plainText),
  );
  const lines = normalizeLines(selectedText);
  const forwarded = extractForwardedMessage(lines);
  const subject = extractForwardedSubject(forwarded.headerLines, input.subject);
  const leadType = classifyLead(subject, forwarded.bodyLines);
  const fields = extractFields(
    leadType,
    forwarded.bodyLines,
    forwarded.headerLines,
    subject,
    input,
  );
  return {
    leadType,
    subject,
    emailPreview: cleanPreview(forwarded.bodyLines.join("\n")),
    fields,
  };
}

function chooseLeadText(htmlText: string, plainText: string): string {
  const htmlScore = leadScore(htmlText);
  const plainScore = leadScore(plainText);
  return htmlScore >= plainScore && htmlText ? htmlText : plainText || htmlText;
}

function leadScore(value: string): number {
  return ["Name", "Email", "Phone", "Message", "Your Door Summary"].reduce(
    (score, label) => score + (value.includes(label) ? 1 : 0),
    0,
  );
}

function normalizeLines(value: string): string[] {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

function extractForwardedMessage(lines: string[]): {
  headerLines: string[];
  bodyLines: string[];
} {
  let headerStart = -1;
  let subjectIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^From:\s*.+/i.test(lines[index])) continue;
    const nearbySubject = lines.findIndex(
      (line, candidateIndex) =>
        candidateIndex > index &&
        candidateIndex <= index + 8 &&
        /^Subject:\s*.+/i.test(line),
    );
    if (nearbySubject > index) {
      headerStart = index;
      subjectIndex = nearbySubject;
    }
  }
  if (headerStart < 0 || subjectIndex < 0) {
    return { headerLines: [], bodyLines: lines };
  }
  return {
    headerLines: lines.slice(headerStart, subjectIndex + 1),
    bodyLines: lines.slice(subjectIndex + 1),
  };
}

function extractFields(
  leadType: LeadType,
  lines: string[],
  headerLines: string[],
  subject: string,
  input: LeadParseInput,
): ParsedFields {
  if (leadType === "palladio") {
    return extractPalladioFields(lines, headerLines, subject, input);
  }
  const structured = extractStructuredFields(lines, headerLines, subject, input.date);
  if (leadType === "contact_form") return structured;

  const sender = extractSender(headerLines, input.sender);
  const body = cleanUnstructuredMessage(lines);
  const bodyName =
    body.match(
      /\bmy name is\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,3})/i,
    )?.[1] ?? "";
  return {
    customerName: cleanPersonName(sender.name || bodyName),
    email: sender.email,
    phone: extractPhone(body),
    address: "",
    message: body,
    submittedAt: extractSubmittedAt(headerLines, input.date),
    formId: extractReferenceId(subject),
  };
}

function extractStructuredFields(
  lines: string[],
  headerLines: string[],
  subject: string,
  fallbackDate: string,
): ParsedFields {
  const sections = new Map<string, string[]>();
  let activeLabel: string | null = null;
  for (const line of lines) {
    const normalized = normalizeLabel(line);
    if (formLabelLookup.has(normalized)) {
      activeLabel = normalized;
      if (!sections.has(activeLabel)) sections.set(activeLabel, []);
      continue;
    }
    if (/^Sent from\b/i.test(line)) {
      activeLabel = null;
      continue;
    }
    if (activeLabel) sections.get(activeLabel)!.push(line);
  }
  const first = (label: string) =>
    sections.get(normalizeLabel(label))?.[0] ?? "";
  const rawEmail = first("Email");
  const address =
    first("Address (EIR code/area)") || first("Address");
  return {
    customerName: cleanInlineValue(first("Name")),
    email:
      rawEmail.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "",
    phone: cleanInlineValue(first("Phone")),
    address: cleanInlineValue(address),
    message: cleanMessage(
      (sections.get(normalizeLabel("Message")) ?? []).join("\n"),
    ),
    submittedAt: extractSubmittedAt(headerLines, fallbackDate),
    formId: extractReferenceId(subject),
  };
}

function extractPalladioFields(
  lines: string[],
  headerLines: string[],
  subject: string,
  input: LeadParseInput,
): ParsedFields {
  const sender = extractSender(headerLines, input.sender);
  const summary = extractPalladioSummary(lines);
  const contact = extractPalladioContact(lines);
  const replyEnd = lines.findIndex((line) =>
    /^(?:W dniu\b|On .+wrote:|Thank you for requesting a quote|Your new Palladio Door)/i.test(
      line,
    ),
  );
  const replyLines = (replyEnd >= 0 ? lines.slice(0, replyEnd) : [])
    .filter((line) => !/^\[Logo]/i.test(line))
    .filter(
      (line, index, values) =>
        !(
          index === values.length - 1 &&
          sender.name &&
          normalizeLabel(line) === normalizeLabel(sender.name)
        ),
    );
  const quoteId =
    subject.match(/Palladio Quote Request\s*#?(\d+)/i)?.[1] ?? "";
  const summaryText = summary
    .map(({ label, value }) => `${label}: ${value}`)
    .join("\n");
  const message = [
    cleanMessage(replyLines.join("\n")),
    quoteId ? `Palladio quote #${quoteId}` : "Palladio door quote",
    summaryText,
  ]
    .filter(Boolean)
    .join("\n\n");
  const greetingName = lines
    .find((line) => /^Hi\s+[^,]+,/i.test(line))
    ?.replace(/^Hi\s+/i, "")
    .replace(/,$/, "")
    .trim();
  return {
    customerName: cleanPersonName(
      contact.customerName || sender.name || greetingName || "",
    ),
    email: contact.email || sender.email,
    phone: contact.phone,
    address: contact.address,
    message,
    submittedAt: extractSubmittedAt(headerLines, input.date),
    formId: quoteId,
  };
}

function extractPalladioContact(lines: string[]): {
  customerName: string;
  email: string;
  phone: string;
  address: string;
} {
  const empty = { customerName: "", email: "", phone: "", address: "" };
  const lastSummaryField = lines.reduce(
    (lastIndex, line, index) =>
      palladioLabels.some((label) =>
        normalizeLabel(line).startsWith(normalizeLabel(label)),
      )
        ? index
        : lastIndex,
    -1,
  );
  if (lastSummaryField < 0) return empty;

  const tail = lines.slice(lastSummaryField + 1);
  for (let index = 0; index < tail.length; index += 1) {
    const line = tail[index];
    for (const { key, labels } of palladioContactLabels) {
      const label = labels.find((candidate) =>
        new RegExp(`^${escapeRegex(candidate)}(?:\\s*:|$)`, "i").test(line),
      );
      if (!label) continue;

      let value = line.slice(label.length).replace(/^\s*:\s*/, "").trim();
      if (!value) {
        const next = tail[index + 1] ?? "";
        const nextIsLabel = palladioContactLabels.some(({ labels: candidates }) =>
          candidates.some((candidate) =>
            new RegExp(`^${escapeRegex(candidate)}(?:\\s*:|$)`, "i").test(next),
          ),
        );
        if (!nextIsLabel) value = next;
      }

      const cleaned = cleanInlineValue(value);
      if (key === "email") {
        empty.email =
          cleaned.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
      } else {
        empty[key] = cleaned;
      }
    }
  }
  return empty;
}

function extractPalladioSummary(
  lines: string[],
): Array<{ label: string; value: string }> {
  const summaryStart = lines.findIndex((line) => /Your Door Summary/i.test(line));
  const source = summaryStart >= 0 ? lines.slice(summaryStart + 1) : lines;
  const results: Array<{ label: string; value: string }> = [];
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    const label = palladioLabels.find((candidate) =>
      normalizeLabel(line).startsWith(normalizeLabel(candidate)),
    );
    if (!label) continue;
    let value = line.slice(label.length).trim();
    if (!value) {
      const next = source[index + 1] ?? "";
      const nextIsLabel = palladioLabels.some(
        (candidate) => normalizeLabel(next) === normalizeLabel(candidate),
      );
      if (!nextIsLabel) value = next;
    }
    value = cleanInlineValue(value);
    if (value) results.push({ label, value });
  }
  return results;
}

function classifyLead(subject: string, lines: string[]): LeadType {
  if (
    /Palladio Quote Request/i.test(subject) ||
    lines.some((line) => /Your Door Summary/i.test(line))
  ) {
    return "palladio";
  }
  const normalized = new Set(lines.map(normalizeLabel));
  const labelCount = ["Name", "Email", "Phone", "Message"].filter((label) =>
    normalized.has(normalizeLabel(label)),
  ).length;
  if (
    labelCount >= 3 ||
    /(?:Website )?Contact Form|New Entry:/i.test(subject)
  ) {
    return "contact_form";
  }
  return "email";
}

function extractSender(
  headerLines: string[],
  fallback: LeadParseInput["sender"],
): { name: string; email: string } {
  const from = headerLines
    .find((line) => /^From:/i.test(line))
    ?.replace(/^From:\s*/i, "");
  if (from) {
    const email =
      from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
    const name = from
      .replace(/<[^>]*>/g, "")
      .replace(email, "")
      .replace(/^['"]|['"]$/g, "")
      .trim();
    return { name, email };
  }
  return {
    name: fallback?.name?.trim() ?? "",
    email: fallback?.email?.trim() ?? "",
  };
}

function cleanUnstructuredMessage(lines: string[]): string {
  const end = lines.findIndex((line) =>
    /^(?:From:|On .+wrote:|_{5,}|This email is sent on behalf of)/i.test(line),
  );
  return cleanMessage((end >= 0 ? lines.slice(0, end) : lines).join("\n"));
}

function extractPhone(value: string): string {
  return (
    value
      .match(/(?:\+353|00353|0)[\d\s()-]{7,16}\d/)?.[0]
      ?.replace(/\s+/g, "")
      .trim() ?? ""
  );
}

function extractReferenceId(subject: string): string {
  return (
    subject.match(/ID\s*#?(\d+)/i)?.[1] ??
    subject.match(/(?:Contact Form|Quote Request)\s*#?(\d+)/i)?.[1] ??
    ""
  );
}

function extractSubmittedAt(lines: string[], fallback: string): string {
  const value = lines
    .find((line) => /^Sent:\s*/i.test(line))
    ?.replace(/^Sent:\s*/i, "")
    .trim();
  if (value) {
    const match = value.match(
      /^(?:[A-Za-z]+,\s*)?(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})/,
    );
    if (match) {
      const month = monthNumber(match[2]);
      if (month) {
        return `${match[3]}-${month}-${match[1].padStart(2, "0")}T${match[4].padStart(2, "0")}:${match[5]}`;
      }
    }
  }
  const parsed = Date.parse(value || fallback);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

function monthNumber(name: string): string | null {
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const index = months.findIndex((month) => month.startsWith(name.toLowerCase()));
  return index >= 0 ? String(index + 1).padStart(2, "0") : null;
}

function extractForwardedSubject(lines: string[], fallback: string): string {
  return (
    lines
      .findLast((line) => /^Subject:/i.test(line))
      ?.replace(/^Subject:\s*/i, "")
      .trim() || fallback.replace(/^Fw:\s*/i, "")
  );
}

function cleanInlineValue(value: string): string {
  return value
    .replace(/<mailto:[^>]+>/gi, "")
    .replace(/^mailto:/i, "")
    .trim();
}

function cleanMessage(value: string): string {
  return value
    .replace(/\[https?:\/\/[^\]]+]\s*/gi, "")
    .replace(/<https?:\/\/[^>]+>/gi, "")
    .trim();
}

function cleanPreview(value: string): string {
  return value
    .replace(/<mailto:[^>]+>/gi, "")
    .replace(/\[(https?:\/\/[^\]]+)]/gi, "$1")
    .trim()
    .slice(0, 50_000);
}

function cleanPersonName(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+via\s+.+$/i, "").trim();
}

function normalizeTextCharacters(value: string): string {
  return value
    .replace(/[\u0091\u0092]/g, "'")
    .replace(/[\u0093\u0094]/g, '"')
    .replace(/([A-Za-z])\uFFFD([A-Za-z])/g, "$1'$2");
}

function normalizeLabel(value: string): string {
  return value.replace(/:$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
