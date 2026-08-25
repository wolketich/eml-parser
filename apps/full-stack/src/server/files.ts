import path from "node:path";

const unsafeFilenameCharacters = /[<>:"/\\|?*\u0000-\u001f]/g;

export function sanitizeFilename(name: string, fallback = "attachment"): string {
  const basename = path.basename(name || fallback);
  const cleaned = basename
    .normalize("NFKC")
    .replace(unsafeFilenameCharacters, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return (cleaned || fallback).slice(0, 180);
}

export function filenameFromUrl(url: string, fallback = "download"): string {
  try {
    const parsed = new URL(url);
    return sanitizeFilename(
      decodeURIComponent(parsed.pathname.split("/").pop() || fallback),
      fallback,
    );
  } catch {
    return fallback;
  }
}

export function uniqueFilename(name: string, used: Set<string>): string {
  const safe = sanitizeFilename(name);
  if (!used.has(safe.toLowerCase())) {
    used.add(safe.toLowerCase());
    return safe;
  }
  const extension = path.extname(safe);
  const stem = path.basename(safe, extension);
  let index = 2;
  let candidate = `${stem}-${index}${extension}`;
  while (used.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${stem}-${index}${extension}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}
