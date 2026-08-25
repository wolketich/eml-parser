import { describe, expect, it } from "vitest";
import { parseEml } from "../../apps/full-stack/src/server/parser";

const syntheticEmail = [
  "From: Form Service <forms@example.com>",
  "To: Sales <sales@example.com>",
  "Subject: Fw: New Entry: Contact Form (ID #1234)",
  "References: <submission-123@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body>",
  "<p>From: Form Service</p>",
  "<p>Sent: 04 June 2026 09:15</p>",
  "<p>Subject: New Entry: Contact Form (ID #1234)</p>",
  "<table>",
  "<tr><td><strong>Name</strong></td></tr><tr><td>Example Person</td></tr>",
  "<tr><td><strong>Email</strong></td></tr><tr><td>person@example.com</td></tr>",
  "<tr><td><strong>Phone</strong></td></tr><tr><td>+353871234567</td></tr>",
  "<tr><td><strong>Address (EIR code/area)</strong></td></tr><tr><td>D02 X285</td></tr>",
  "<tr><td><strong>Message</strong></td></tr><tr><td>Please see the attached plan.</td></tr>",
  "</table>",
  "</body></html>",
  "--outer",
  "Content-Type: image/png",
  "Content-Disposition: inline; filename=Outlook-signature.png",
  "Content-ID: <signature>",
  "Content-Transfer-Encoding: base64",
  "",
  "aW5saW5l",
  "--outer",
  "Content-Type: application/pdf",
  "Content-Disposition: attachment; filename=measurements.pdf",
  "Content-Transfer-Encoding: base64",
  "",
  "cGRmLWNvbnRlbnQ=",
  "--outer--",
  "",
].join("\r\n");

const syntheticPalladioEmail = [
  "From: Quote Service <quotes@example.com>",
  "To: Sales <sales@example.com>",
  "Subject: Your Palladio Quote Request #246810",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hi Aisling,",
  "Thank you for requesting a quote from the Palladio Collection",
  "",
  "Your Door Summary",
  "Frame Type: Door in Frame",
  "Door style: Dublin",
  "Glazing: TG501",
  "",
  "Contact Details",
  "Name: Aisling Murphy",
  "Email: aisling.murphy@example.com",
  "Phone: 087 123 4567",
  "Address: 12 Example Road, Dublin, D12 AB34",
  "",
].join("\r\n");

function syntheticContactEmail(messageHtml: string): string {
  return [
    "From: Form Service <forms@example.com>",
    "To: Sales <sales@example.com>",
    "Subject: New Entry: Contact Form (ID #5678)",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><table>",
    "<tr><td><strong>Name</strong></td></tr><tr><td>Example Customer</td></tr>",
    "<tr><td><strong>Email</strong></td></tr><tr><td>customer@example.com</td></tr>",
    "<tr><td><strong>Phone</strong></td></tr><tr><td>087 000 0000</td></tr>",
    "<tr><td><strong>Message</strong></td></tr>",
    `<tr><td>${messageHtml}</td></tr>`,
    "</table></body></html>",
  ].join("\r\n");
}

describe("parseEml", () => {
  it("extracts a forwarded form and excludes inline branding", async () => {
    const parsed = await parseEml(Buffer.from(syntheticEmail), "submission.eml");

    expect(parsed.fields).toMatchObject({
      customerName: "Example Person",
      email: "person@example.com",
      phone: "+353871234567",
      address: "D02 X285",
      submittedAt: "2026-06-04T09:15",
      formId: "1234",
    });
    expect(parsed.fields.message).toBe("Please see the attached plan.");
    expect(parsed.messageKey).toBe("submission-123@example.com");
    expect(parsed.mimeAttachments.map((file) => file.originalName)).toEqual([
      "measurements.pdf",
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it("extracts customer contact details from the end of a Palladio quote", async () => {
    const parsed = await parseEml(
      Buffer.from(syntheticPalladioEmail),
      "palladio-quote.eml",
    );

    expect(parsed.leadType).toBe("palladio");
    expect(parsed.fields).toMatchObject({
      customerName: "Aisling Murphy",
      email: "aisling.murphy@example.com",
      phone: "087 123 4567",
      address: "12 Example Road, Dublin, D12 AB34",
      formId: "246810",
    });
  });

  it("warns when an email mentions a file but contains no downloadable file", async () => {
    const parsed = await parseEml(
      Buffer.from(syntheticContactEmail("Please see the attached photos.")),
      "missing-upload.eml",
    );

    expect(parsed.mimeAttachments).toHaveLength(0);
    expect(parsed.remoteFiles).toHaveLength(0);
    expect(parsed.warnings.join(" ")).toMatch(/no downloadable customer files/i);
  });

  it("extracts WordPress form-upload links", async () => {
    const parsed = await parseEml(
      Buffer.from(
        syntheticContactEmail(
          'Please review <a href="https://uploads.example.com/wpforms/5678/window.jpg">window.jpg</a>.',
        ),
      ),
      "remote-upload.eml",
    );

    expect(parsed.fields.email).toBe("customer@example.com");
    expect(parsed.fields.formId).toBe("5678");
    expect(parsed.mimeAttachments).toHaveLength(0);
    expect(parsed.remoteFiles).toHaveLength(1);
    expect(parsed.remoteFiles[0]).toMatchObject({
      originalName: "window.jpg",
      mimeType: "image/jpeg",
    });
  });
});
