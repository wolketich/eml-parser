import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MONDAY_FILE_ENDPOINT,
  buildColumnValues,
  buildFileUploadFormData,
  normalizePhone,
  uploadFileToColumn,
} from "../../apps/full-stack/src/server/monday";

const baseMapping = {
  boardId: "1",
  groupId: "group",
  columns: {
    email: "email",
    phone: "phone",
    address: "address",
    message: "message",
    submittedAt: "date",
    formId: "form",
    files: "files",
  },
};

const baseFields = {
  customerName: "Example",
  email: "person@example.com",
  phone: "+353871234567",
  address: "D02 X285",
  message: "Hello",
  submittedAt: "2026-06-04T09:15",
  formId: "1234",
};

const typedColumns = {
  email: "email",
  phone: "phone",
  address: "text",
  message: "long_text",
  date: "date",
  form: "text",
  files: "file",
};

describe("buildColumnValues", () => {
  it("formats monday email, phone, date, long text, and plain text values", () => {
    const values = buildColumnValues(baseMapping, baseFields, typedColumns);

    expect(values).toEqual({
      email: { email: "person@example.com", text: "person@example.com" },
      phone: { phone: "+353871234567", countryShortName: "IE" },
      address: "D02 X285",
      message: { text: "Hello" },
      form: "1234",
      date: { date: "2026-06-04", time: "09:15:00" },
    });
  });

  it("uses plain strings for email and phone mapped to text columns", () => {
    const values = buildColumnValues(
      baseMapping,
      baseFields,
      { ...typedColumns, email: "text", phone: "long_text" },
    );

    expect(values.email).toBe("person@example.com");
    expect(values.phone).toEqual({ text: "+353871234567" });
  });

  it("keeps address as plain text", () => {
    const values = buildColumnValues(baseMapping, baseFields, typedColumns);

    expect(values.address).toBe("D02 X285");
  });

  it("excludes file columns from create_item column values", () => {
    const values = buildColumnValues(baseMapping, baseFields, typedColumns);

    expect(values).not.toHaveProperty("files");
  });

  it("formats date-only submittedAt without a time component", () => {
    const values = buildColumnValues(
      baseMapping,
      { ...baseFields, submittedAt: "2026-06-04" },
      typedColumns,
    );

    expect(values.date).toEqual({ date: "2026-06-04" });
  });

  it("formats space-separated monday date strings with seconds", () => {
    const values = buildColumnValues(
      baseMapping,
      { ...baseFields, submittedAt: "2026-06-15 09:00:00" },
      typedColumns,
    );

    expect(values.date).toEqual({ date: "2026-06-15", time: "09:00:00" });
  });
});

describe("normalizePhone", () => {
  it("converts Irish local numbers to E.164", () => {
    expect(normalizePhone("012336092")).toEqual({
      phone: "+35312336092",
      countryShortName: "IE",
    });
  });

  it("preserves numbers already in +353 format", () => {
    expect(normalizePhone("+353871234567")).toEqual({
      phone: "+353871234567",
      countryShortName: "IE",
    });
  });
});

describe("file upload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a multipart form for the monday file endpoint", () => {
    const form = buildFileUploadFormData(
      "item-1",
      "files",
      "source.eml",
      Buffer.from("email"),
      "message/rfc822",
    );

    expect(form.get("query")).toContain("add_file_to_column");
    expect(form.get("variables")).toBe(
      JSON.stringify({ itemId: "item-1", columnId: "files", file: null }),
    );
    expect(form.get("map")).toBe(JSON.stringify({ file: ["variables.file"] }));
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("uploads via https://api.monday.com/v2/file and returns the asset", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          add_file_to_column: {
            id: "asset-1",
            name: "source.eml",
            url: "https://files.monday.com/source.eml",
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const asset = await uploadFileToColumn(
      "token",
      "2026-04",
      "item-1",
      "files",
      "source.eml",
      Buffer.from("email"),
      "message/rfc822",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      MONDAY_FILE_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "token",
          "API-Version": "2026-04",
        },
      }),
    );
    expect(asset).toEqual({
      id: "asset-1",
      name: "source.eml",
      url: "https://files.monday.com/source.eml",
    });
  });

  it("surfaces monday file upload errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error_message: "Invalid column id files",
        }),
      }),
    );

    await expect(
      uploadFileToColumn(
        "token",
        "2026-04",
        "item-1",
        "files",
        "source.eml",
        Buffer.from("email"),
        "message/rfc822",
      ),
    ).rejects.toThrow("Invalid column id files");
  });
});
