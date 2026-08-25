import MsgReaderModule, { type FieldsData } from "@kenjiuno/msgreader";
import type { Attachment, Email } from "postal-mime";

type MsgReaderInstance = {
  getFileData(): FieldsData;
  getAttachment(attach: number | FieldsData): { fileName: string; content: Uint8Array };
};

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export function isSupportedMailFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".eml") || lower.endsWith(".msg");
}

export function isMsgSource(raw: Buffer, sourceName: string): boolean {
  if (sourceName.toLowerCase().endsWith(".msg")) return true;
  return raw.length >= OLE_MAGIC.length && raw.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC);
}

export function sourceMimeType(sourceName: string): string {
  return sourceName.toLowerCase().endsWith(".msg")
    ? "application/vnd.ms-outlook"
    : "message/rfc822";
}

export function parseMsgToEmail(raw: Buffer): Email {
  const reader = createMsgReader(raw);
  const msg = reader.getFileData();
  return msgToEmail(msg, reader);
}

function createMsgReader(raw: Buffer): MsgReaderInstance {
  const MsgReader =
    (MsgReaderModule as { default?: new (buffer: ArrayBuffer) => MsgReaderInstance })
      .default ??
    (MsgReaderModule as unknown as new (buffer: ArrayBuffer) => MsgReaderInstance);
  const arrayBuffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  ) as ArrayBuffer;
  return new MsgReader(arrayBuffer);
}

function msgToEmail(msg: FieldsData, reader: MsgReaderInstance): Email {
  const html = msg.html ? Buffer.from(msg.html).toString("utf8") : undefined;
  const text = msg.body || msg.preview || undefined;
  const attachments = (msg.attachments ?? []).flatMap((attach) => {
    const file = reader.getAttachment(attach);
    if (!file?.content?.length) return [];
    const filename = file.fileName || attach.fileName || "attachment";
    return [
      {
        filename,
        mimeType: attach.attachMimeTag || "application/octet-stream",
        content: file.content,
        disposition: isMsgInlineAttachment(attach, filename) ? "inline" : "attachment",
        related: isMsgInlineAttachment(attach, filename),
        contentId: attach.pidContentId,
      } satisfies Attachment,
    ];
  });

  return {
    subject: msg.subject,
    date: msg.clientSubmitTime || msg.messageDeliveryTime,
    messageId: msg.messageId,
    references: extractHeaderValue(msg.headers, "References"),
    inReplyTo: extractHeaderValue(msg.headers, "In-Reply-To"),
    html,
    text,
    attachments,
    headers: {},
    headerLines: [],
  } as unknown as Email;
}

function extractHeaderValue(headers: string | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const match = headers.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function isMsgInlineAttachment(
  attach: NonNullable<FieldsData["attachments"]>[number],
  filename: string,
): boolean {
  return (
    Boolean(attach.attachmentHidden) ||
    /^Outlook-[^.]+\.(?:png|jpe?g|gif)$/i.test(filename)
  );
}
