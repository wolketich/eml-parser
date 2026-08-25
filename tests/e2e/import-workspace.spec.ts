import { expect, test } from "@playwright/test";

const parsedImport = {
  id: "import-1",
  sourceName: "submission.eml",
  subject: "New Entry: Contact Form",
  leadType: "contact_form",
  emailPreview: "",
  fields: {
    customerName: "Example Customer",
    email: "customer@example.com",
    phone: "+353871234567",
    address: "D02 X285",
    message: "Please quote for new windows.",
    submittedAt: "2026-06-04T09:15",
    formId: "1234",
  },
  warnings: [],
  status: "parsed",
  duplicate: false,
  mondayItemId: null,
  mondayItemUrl: null,
  error: null,
  attachments: [
    {
      id: "file-1",
      kind: "source",
      originalName: "submission.eml",
      mimeType: "message/rfc822",
      sourceUrl: null,
      sizeBytes: 1024,
      status: "downloaded",
      error: null,
      mondayAssetId: null,
      viewable: true,
      downloadable: true,
    },
  ],
  createdAt: "2026-06-09T09:00:00.000Z",
  updatedAt: "2026-06-09T09:00:00.000Z",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/imports", (route) =>
    route.fulfill({ json: { imports: [] } }),
  );
  await page.route("**/api/parse", (route) =>
    route.fulfill({ json: { imports: [parsedImport] } }),
  );
  await page.route("**/api/monday/status", (route) =>
    route.fulfill({
      json: {
        configured: false,
        connected: false,
        userName: null,
        error: "MONDAY_API_TOKEN is not configured.",
      },
    }),
  );
  await page.route("**/api/settings/mapping", (route) =>
    route.fulfill({ json: { mapping: null } }),
  );
});

test("uploads an EML into the editable review queue", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /review form enquiries/i }),
  ).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "submission.eml",
    mimeType: "message/rfc822",
    buffer: Buffer.from("Subject: Example"),
  });

  await expect(page.getByText("Example Customer")).toBeVisible();
  await expect(page.getByLabel("Customer name")).toHaveValue("Example Customer");
  await expect(page.getByText("Original email")).toBeVisible();
});

test("shows local token guidance in settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Token not configured")).toBeVisible();
  await expect(page.getByText("MONDAY_API_TOKEN", { exact: true })).toBeVisible();
});

test("guides missing details beside an unstructured email preview", async ({ page }) => {
  await page.route("**/api/imports", (route) =>
    route.fulfill({
      json: {
        imports: [
          {
            ...parsedImport,
            id: "plain-email",
            leadType: "email",
            subject: "Windows replacement enquiry",
            emailPreview:
              "Good afternoon,\n\nPlease quote for replacement windows in Balbriggan.",
            fields: {
              ...parsedImport.fields,
              phone: "",
              address: "",
            },
          },
        ],
      },
    }),
  );

  await page.goto("/");
  await expect(page.getByText("Email preview")).toBeVisible();
  await expect(page.getByText(/Please quote for replacement windows/)).toBeVisible();

  const guide = page.locator(".guided-details");
  await expect(guide.getByLabel("Phone")).toBeVisible();
  await guide.getByLabel("Phone").fill("+353870001234");
  await guide.getByRole("button", { name: /save and continue/i }).click();
  await expect(guide.getByLabel("Address / Eircode")).toBeVisible();
});
