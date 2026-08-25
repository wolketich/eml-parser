import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { JSDOM, VirtualConsole } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

const fixtures = path.resolve(".local", "fixtures");
const emailSamples = path.join(fixtures, "email-samples");
const debuggingSamples = path.join(fixtures, "debugging");
const datedRegressionSamples = path.join(fixtures, "regression", "2026-08-25");
const hasFixtures = fsSync.existsSync(emailSamples);
const describeWithFixtures = hasFixtures ? describe : describe.skip;
const describeWithRegression = fsSync.existsSync(datedRegressionSamples)
  ? describe
  : describe.skip;
const run = promisify(execFile);

beforeAll(async () => {
  await run(process.execPath, ["tools/build-standalone.mjs"]);
});

describe("standalone bridge integration", () => {
  it("creates the item and uploads the source mail through the configured bridge", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { dom, browserErrors } = await createStandaloneDom({
      defaults: {
        bridgeUrl: "https://bridge.example",
        bridgeKey: "test-bridge-key",
        boardId: "board-1",
        groupId: "group-1",
        filesColumn: "files",
      },
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/monday/graphql")) {
          return Response.json({
            data: { create_item: { id: "item-1", url: "https://monday.example/item-1" } },
          });
        }
        if (url.endsWith("/monday/upload")) {
          return Response.json({ data: { add_file_to_column: { id: "asset-1" } } });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await dropBytes(
      dom,
      "submission.eml",
      Buffer.from([
        "From: Form Service <forms@example.com>",
        "Subject: New Entry: Contact Form (ID #1234)",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Name",
        "Example Customer",
        "Email",
        "customer@example.com",
        "Phone",
        "087 000 0000",
        "Message",
        "Please call me.",
      ].join("\r\n")),
    );
    dom.window.document.querySelector<HTMLButtonElement>('[data-action="import"]')?.click();
    await waitFor(() => dom.window.document.querySelector(".record.status-complete"));

    expect(requests.map(({ url }) => url)).toEqual([
      "https://bridge.example/monday/graphql",
      "https://bridge.example/monday/upload",
    ]);
    expect(new Headers(requests[0].init?.headers).get("Authorization")).toBe(
      "Bearer test-bridge-key",
    );
    const upload = requests[1].init?.body as FormData;
    expect(upload.get("itemId")).toBe("item-1");
    expect(upload.get("sourceUrl")).toBeNull();
    expect(upload.get("file")).toBeTruthy();
    expect(browserErrors).toEqual([]);
    dom.window.close();
  });
});

describeWithFixtures("standalone browser build", () => {

  it("constructs the bundled MSG reader", async () => {
    const { dom, browserErrors } = await createStandaloneDom();

    await dropFile(dom, path.join(emailSamples, "palladio.msg"));

    expect(dom.window.document.querySelector(".toast")?.textContent ?? "").not.toContain(
      "is not a constructor",
    );
    expect(recordByKind(dom, "Palladio")).toBeTruthy();
    expect(browserErrors).toEqual([]);
    dom.window.close();
  });

  it("parses every EML and MSG sample into the expected review flow", async () => {
    const { dom, browserErrors } = await createStandaloneDom();
    const names = [
      "contact-form.eml",
      "contact-form.msg",
      "no-contact-form.eml",
      "no-contact-form.msg",
      "palladio.eml",
      "palladio.msg",
    ];
    for (const name of names) {
      await dropFile(dom, path.join(emailSamples, name));
    }

    expect(dom.window.document.querySelectorAll(".record")).toHaveLength(5);

    const contact = recordByKind(dom, "Contact form");
    expect(fieldValue(contact, "email")).toMatch(/^[^@]+@[^@]+$/);
    expect(fieldValue(contact, "phone")).toBeTruthy();

    const plainEmail = recordByKind(dom, "Email");
    expect(fieldValue(plainEmail, "email")).toMatch(/^[^@]+@[^@]+$/);
    expect(plainEmail.querySelector(".email-preview")?.textContent).toBeTruthy();
    expect(plainEmail.querySelector(".guided-details input")?.getAttribute("type")).toBe("tel");
    expect(plainEmail.querySelectorAll(".file-row")).toHaveLength(10);

    const phoneGuide = plainEmail.querySelector<HTMLInputElement>(".guided-details input");
    if (!phoneGuide) throw new Error("Phone guide was not rendered.");
    phoneGuide.value = "+353 85 123 4567";
    phoneGuide.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    plainEmail.querySelector<HTMLButtonElement>('[data-action="guide-next"]')?.click();

    const addressGuide = recordByKind(dom, "Email");
    expect(fieldValue(addressGuide, "phone")).toBe("+353 85 123 4567");
    expect(addressGuide.querySelector(".guided-details input")?.getAttribute("placeholder")).toBe(
      "Address or Eircode",
    );

    const palladio = recordByKind(dom, "Palladio");
    expect(fieldValue(palladio, "email")).toMatch(/^[^@]+@[^@]+$/);
    expect(fieldValue(palladio, "formId")).toMatch(/^\d+$/);
    expect(palladio.querySelector("textarea")?.value).toMatch(/Door style:/);
    expect(palladio.querySelectorAll(".file-row")).toHaveLength(2);

    const debuggingFiles = fsSync.existsSync(debuggingSamples)
      ? (await fs.readdir(debuggingSamples)).filter((name) => /\.(?:eml|msg)$/i.test(name))
      : [];
    for (const name of debuggingFiles) {
      await dropFile(dom, path.join(debuggingSamples, name));
    }

    expect(dom.window.document.querySelector(".toast")?.textContent ?? "").not.toContain(
      "is not a constructor",
    );

    expect(browserErrors).toEqual([]);
    dom.window.close();
  });
});

describeWithRegression("standalone dated regression mail", () => {
  it("parses the complete 2026-08-25 MSG batch without browser errors", async () => {
    const { dom, browserErrors } = await createStandaloneDom();
    const names = (await fs.readdir(datedRegressionSamples)).filter((name) =>
      /\.(?:eml|msg)$/i.test(name),
    );

    for (const name of names) {
      await dropFile(dom, path.join(datedRegressionSamples, name));
    }

    expect(names).toHaveLength(27);
    expect(dom.window.document.querySelectorAll(".record").length).toBeGreaterThan(0);
    expect(dom.window.document.querySelector(".toast")?.textContent ?? "").not.toContain(
      "could not be loaded",
    );
    expect(browserErrors).toEqual([]);
    dom.window.close();
  });
});

async function createStandaloneDom(options: {
  defaults?: {
    bridgeUrl: string;
    bridgeKey: string;
    boardId: string;
    groupId: string;
    filesColumn: string;
  };
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
} = {}): Promise<{
  dom: JSDOM;
  browserErrors: Error[];
}> {
  let html = await fs.readFile("artifacts/github-pages/index.html", "utf8");
  if (options.defaults) {
    html = html
      .replace('bridgeUrl: "",', `bridgeUrl: "${options.defaults.bridgeUrl}",`)
      .replace('bridgeKey: "",', `bridgeKey: "${options.defaults.bridgeKey}",`)
      .replace('boardId: "",', `boardId: "${options.defaults.boardId}",`)
      .replace('groupId: "",', `groupId: "${options.defaults.groupId}",`)
      .replace('files: ""', `files: "${options.defaults.filesColumn}"`);
  }
  const browserErrors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => browserErrors.push(error));
  virtualConsole.on("error", (error) => browserErrors.push(error));

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    resources: "usable",
    url: "http://127.0.0.1/index.html",
    virtualConsole,
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      window.confirm = () => true;
      window.fetch = options.fetch ?? (async () => {
        throw new Error("Network calls are disabled in parser tests.");
      });
      if (!window.crypto.randomUUID) {
        window.crypto.randomUUID = () => globalThis.crypto.randomUUID();
      }
      if (!window.crypto.subtle) {
        Object.defineProperty(window.crypto, "subtle", {
          value: globalThis.crypto.subtle,
        });
      }
      window.File.prototype.arrayBuffer = function arrayBuffer() {
        return new Promise((resolve, reject) => {
          const reader = new window.FileReader();
          reader.addEventListener("load", () => resolve(reader.result as ArrayBuffer));
          reader.addEventListener("error", () => reject(reader.error));
          reader.readAsArrayBuffer(this);
        });
      };
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function showModal() {
          this.open = true;
        };
      }
    },
  });

  await waitFor(() => dom.window.document.querySelector(".drop"));
  return { dom, browserErrors };
}

async function dropFile(dom: JSDOM, filePath: string): Promise<void> {
  const raw = await fs.readFile(filePath);
  await dropBytes(dom, path.basename(filePath), raw);
}

async function dropBytes(dom: JSDOM, name: string, raw: Uint8Array): Promise<void> {
  const file = new dom.window.File([Uint8Array.from(raw).buffer], name);
  const event = new dom.window.Event("drop", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
  dom.window.document.dispatchEvent(event);
  await waitFor(
    () => !dom.window.document.querySelector(".drop")?.textContent?.includes("Reading"),
  );
}

function recordByKind(dom: JSDOM, kind: string): HTMLElement {
  const record = [...dom.window.document.querySelectorAll<HTMLElement>(".record")].find(
    (element) => element.querySelector(".lead-kind")?.textContent === kind,
  );
  if (!record) throw new Error(`Record type not found: ${kind}`);
  return record;
}

function fieldValue(record: HTMLElement, key: string): string {
  return record.querySelector<HTMLInputElement>(`input[data-field="${key}"]`)?.value ?? "";
}

async function waitFor(test: () => unknown, timeout = 15_000): Promise<void> {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for standalone UI.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
