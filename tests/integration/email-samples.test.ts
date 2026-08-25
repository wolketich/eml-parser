import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMail } from "../../apps/full-stack/src/server/parser";

const samples = path.resolve(".local", "fixtures", "email-samples");
const describeWithFixtures = fs.existsSync(samples) ? describe : describe.skip;

async function parsePair(name: string) {
  const eml = await parseMail(
    fs.readFileSync(path.join(samples, `${name}.eml`)),
    `${name}.eml`,
  );
  const msg = await parseMail(
    fs.readFileSync(path.join(samples, `${name}.msg`)),
    `${name}.msg`,
  );
  return { eml, msg };
}

describeWithFixtures("local email sample corpus", () => {
  it("extracts the customer rather than the company from contact forms", async () => {
    const { eml, msg } = await parsePair("contact-form");

    for (const parsed of [eml, msg]) {
      expect(parsed.leadType).toBe("contact_form");
      expect(parsed.fields.customerName).toBeTruthy();
      expect(parsed.fields.customerName).not.toMatch(/expert windows/i);
      expect(parsed.fields.email).toMatch(/^[^@]+@[^@]+$/);
      expect(parsed.fields.phone).toBeTruthy();
      expect(parsed.fields.address).toBeTruthy();
      expect(parsed.fields.message).toBeTruthy();
      expect(parsed.emailPreview).toContain(parsed.fields.customerName);
      expect(parsed.mimeAttachments).toHaveLength(0);
    }
    expect(msg.fields).toEqual(eml.fields);
  });

  it("keeps unstructured email content and extracts sender details", async () => {
    const { eml, msg } = await parsePair("no-contact-form");

    for (const parsed of [eml, msg]) {
      expect(parsed.leadType).toBe("email");
      expect(parsed.fields.customerName).toBeTruthy();
      expect(parsed.fields.email).toMatch(/^[^@]+@[^@]+$/);
      expect(parsed.fields.phone).toBe("");
      expect(parsed.fields.address).toBe("");
      expect(parsed.fields.message).toBeTruthy();
      expect(parsed.emailPreview).toBeTruthy();
      expect(parsed.mimeAttachments).toHaveLength(9);
    }
    expect(msg.fields).toEqual(eml.fields);
  });

  it("parses the repeatable Palladio quote structure", async () => {
    const { eml, msg } = await parsePair("palladio");

    for (const parsed of [eml, msg]) {
      expect(parsed.leadType).toBe("palladio");
      expect(parsed.fields.customerName).toBeTruthy();
      expect(parsed.fields.email).toMatch(/^[^@]+@[^@]+$/);
      expect(parsed.fields.phone).toBe("");
      expect(parsed.fields.address).toBe("");
      expect(parsed.fields.formId).toMatch(/^\d+$/);
      expect(parsed.fields.message).toMatch(/Frame Type:/);
      expect(parsed.fields.message).toMatch(/Door style:/);
      expect(parsed.fields.message).toMatch(/External door colour:/);
      expect(parsed.fields.message).toMatch(/Furniture colour:/);
      expect(parsed.fields.message).toMatch(/Glazing:/);
      expect(parsed.fields.message).toMatch(/Backing Glass:/);
      expect(parsed.emailPreview).toContain("Your Door Summary");
      expect(parsed.mimeAttachments).toHaveLength(1);
      expect(parsed.mimeAttachments[0].originalName).toMatch(
        /^palladio-quote-\d+-external\.png$/,
      );
    }
    expect(msg.fields).toEqual(eml.fields);
  });
});
