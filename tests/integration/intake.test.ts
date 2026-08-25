import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../apps/full-stack/src/server/database";
import { IntakeService } from "../../apps/full-stack/src/server/intake-service";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("IntakeService", () => {
  it("returns the existing record when the same source is parsed twice", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mail-intake-"));
    tempDirs.push(directory);
    const database = new AppDatabase(directory);
    const intake = new IntakeService(database, directory);
    const raw = Buffer.from(
      [
        "Subject: New Entry: Contact Form (ID #99)",
        "Message-ID: <message-99@example.com>",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Name",
        "Test Person",
        "Email",
        "test@example.com",
        "Phone",
        "+353870000000",
        "Address",
        "Dublin",
        "Message",
        "A test enquiry",
      ].join("\r\n"),
    );

    const first = await intake.ingest(raw, "first.eml");
    const second = await intake.ingest(raw, "again.eml");

    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);
    expect(database.listImports()).toHaveLength(1);
    database.close();
  });
});
