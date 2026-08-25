import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMail } from "../../apps/full-stack/src/server/parser";

const samples = path.resolve(".local", "fixtures", "regression", "2026-08-25");
const describeWithRegression = fs.existsSync(samples) ? describe : describe.skip;

describeWithRegression("2026-08-25 local regression mail", () => {
  it("parses every supplied message", async () => {
    const names = fs.readdirSync(samples).filter((name) => /\.(?:eml|msg)$/i.test(name));
    const parsed = await Promise.all(
      names.map((name) => parseMail(fs.readFileSync(path.join(samples, name)), name)),
    );

    expect(names).toHaveLength(27);
    expect(parsed).toHaveLength(names.length);
    expect(parsed.every((message) => message.subject.length > 0)).toBe(true);
  });
});
