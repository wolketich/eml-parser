import fs from "node:fs";
import path from "node:path";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { MondayMapping } from "../../../../packages/mail-parser/src/types.js";
import { config } from "./config.js";
import { AppDatabase } from "./database.js";
import { SecureDownloader } from "./downloader.js";
import { ImportService } from "./import-service.js";
import { IntakeService } from "./intake-service.js";
import { isSupportedMailFile } from "./msg.js";
import { MondayClient, type MondayGateway } from "./monday.js";

const fieldsSchema = z.object({
  customerName: z.string().max(500),
  email: z.string().max(500),
  phone: z.string().max(200),
  address: z.string().max(1000),
  message: z.string().max(50_000),
  submittedAt: z.string().max(100),
  formId: z.string().max(100),
});

const mappingSchema = z.object({
  boardId: z.string().min(1),
  groupId: z.string().min(1),
  uploadFiles: z.boolean().optional(),
  columns: z.object({
    email: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    message: z.string().optional(),
    submittedAt: z.string().optional(),
    formId: z.string().optional(),
    files: z.string().optional(),
  }),
});

const importOptionsSchema = z.object({
  uploadFiles: z.boolean().optional(),
});

interface AppOptions {
  database?: AppDatabase;
  monday?: MondayGateway;
  dataDir?: string;
  serveClient?: boolean;
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const dataDir = options.dataDir ?? config.dataDir;
  const database = options.database ?? new AppDatabase(dataDir);
  const monday =
    options.monday ?? new MondayClient(config.mondayToken, config.mondayApiVersion);
  const intake = new IntakeService(database, dataDir);
  const downloader = new SecureDownloader(config.maxRemoteFileBytes);
  const importer = new ImportService(database, monday, downloader);
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "test" ? "silent" : "info",
      redact: ["req.headers.authorization"],
    },
    bodyLimit: config.maxEmlBytes,
  });

  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      if (body === "" || body == null) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(String(body)));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  await app.register(multipart, {
    limits: {
      files: config.maxFilesPerBatch,
      fileSize: config.maxEmlBytes,
    },
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/imports", async () => ({ imports: database.listImports() }));

  app.delete("/api/imports", async () => {
    const deleted = database.clearImports();
    return { ok: true, deleted };
  });

  app.get("/api/imports/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = database.getImport(id);
    if (!record) return reply.code(404).send({ error: "Import record was not found." });
    return record;
  });

  app.delete("/api/imports/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!database.deleteImport(id)) {
      return reply.code(404).send({ error: "Import record was not found." });
    }
    return { ok: true };
  });

  app.patch("/api/imports/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = fieldsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "The edited submission is invalid." });
    }
    const record = database.updateFields(id, parsed.data);
    if (!record) return reply.code(404).send({ error: "Import record was not found." });
    return record;
  });

  app.post("/api/parse", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(415).send({ error: "Upload one or more .eml or .msg files." });
    }
    const imports = [];
    for await (const part of request.files()) {
      const filename = String(part.filename ?? "");
      if (!isSupportedMailFile(filename)) {
        part.file.resume();
        continue;
      }
      const raw = await part.toBuffer();
      imports.push(await intake.ingest(raw, filename));
    }
    if (imports.length === 0) {
      return reply.code(400).send({ error: "No .eml or .msg files were provided." });
    }
    return { imports };
  });

  app.get("/api/imports/:id/attachments/:attachmentId/file", async (request, reply) => {
    const { id, attachmentId } = request.params as {
      id: string;
      attachmentId: string;
    };
    const { download } = request.query as { download?: string };
    const asDownload = download === "1";
    const attachment = database.getAttachment(id, attachmentId);
    if (!attachment) {
      return reply.code(404).send({ error: "This file is no longer available." });
    }

    let localPath = attachment.local_path;
    if (
      (!localPath || !fs.existsSync(localPath)) &&
      attachment.kind === "remote" &&
      attachment.source_url &&
      localPath
    ) {
      try {
        const result = await downloader.download(attachment.source_url, localPath);
        localPath = result.path;
        database.updateAttachment(attachmentId, {
          local_path: result.path,
          size_bytes: result.sizeBytes,
          mime_type: result.mimeType,
          status: "downloaded",
          error: null,
        });
      } catch (error) {
        return reply.code(502).send({ error: errorMessage(error) });
      }
    }

    if (!localPath) {
      return reply.code(404).send({ error: "This file is no longer available." });
    }
    const resolved = path.resolve(localPath);
    if (!resolved.startsWith(path.resolve(dataDir))) {
      return reply.code(403).send({ error: "This file cannot be served." });
    }
    if (!fs.existsSync(resolved)) {
      return reply.code(404).send({ error: "This file is no longer available." });
    }
    const filename = attachment.original_name.replace(/"/g, "");
    return reply
      .type(attachment.mime_type || "application/octet-stream")
      .header(
        "Content-Disposition",
        asDownload ? `attachment; filename="${filename}"` : `inline; filename="${filename}"`,
      )
      .send(fs.createReadStream(resolved));
  });

  app.post("/api/import/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = importOptionsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid import options." });
    }
    try {
      return await importer.import(id, parsed.data);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/import/:id/retry-files", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = importOptionsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid import options." });
    }
    try {
      return await importer.retryFiles(id, parsed.data);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/monday/status", async () => monday.testConnection());

  app.get("/api/monday/boards", async (_request, reply) => {
    try {
      return { boards: await monday.listBoards() };
    } catch (error) {
      return reply.code(502).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/monday/boards/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await monday.getBoard(id);
    } catch (error) {
      return reply.code(502).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/settings/mapping", async () => ({
    mapping: database.getMapping(),
  }));

  app.put("/api/settings/mapping", async (request, reply) => {
    const parsed = mappingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Choose a board and group before saving.",
      });
    }
    const mapping = parsed.data as MondayMapping;
    const uploadFiles = mapping.uploadFiles ?? true;
    if (uploadFiles && !mapping.columns.files) {
      return reply.code(400).send({
        error: "Choose a Files column or disable file uploads before saving.",
      });
    }
    return { mapping: database.saveMapping(mapping) };
  });

  const clientDir = path.resolve("artifacts/full-stack/client");
  if ((options.serveClient ?? true) && fs.existsSync(clientDir)) {
    await app.register(fastifyStatic, {
      root: clientDir,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Route not found." });
      }
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    if (!options.database) database.close();
  });

  return app;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}
