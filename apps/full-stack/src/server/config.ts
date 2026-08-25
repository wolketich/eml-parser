import path from "node:path";

const cwd = process.cwd();

export const config = {
  host: process.env.APP_HOST ?? "127.0.0.1",
  port: Number.parseInt(
    process.env.APP_PORT ?? (process.env.NODE_ENV === "production" ? "3000" : "3001"),
    10,
  ),
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(cwd, "data")),
  mondayToken: process.env.MONDAY_API_TOKEN?.trim() ?? "",
  mondayApiVersion: "2026-04",
  maxEmlBytes: 30 * 1024 * 1024,
  maxRemoteFileBytes: Number.parseInt(
    process.env.MAX_REMOTE_FILE_BYTES ?? String(25 * 1024 * 1024),
    10,
  ),
  maxFilesPerBatch: 50,
};
