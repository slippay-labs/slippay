export const ALLOWED_STATIC_EXTENSIONS = new Set([
  "html",
  "js",
  "css",
  "json",
  "png",
  "jpg",
  "jpeg",
  "svg",
  "ico",
  "woff",
  "woff2",
  "txt",
  "webp",
  "xml",
]);

/**
 * Normalises directory and candidate path, asserting strict containment within webDist (issue #186).
 *
 * Enforces:
 * 1. Reject paths containing NUL bytes (\0 or %00).
 * 2. Decode percent-encoding safely; reject if decoded contains NUL bytes.
 * 3. Reject any path containing ".." segments or backslash-escapes.
 * 4. Strictly allow only whitelisted file extensions from ALLOWED_STATIC_EXTENSIONS.
 * 5. Resolve candidate path and assert containment within webDist directory root.
 *
 * Returns the resolved canonical file path string if safe and contained, or null otherwise.
 */
export function resolveSafeStaticPath(webDist: string, requestPath: string): string | null {
  if (!requestPath || typeof requestPath !== "string") return null;
  if (!webDist || typeof webDist !== "string") return null;

  // 1. Reject literal or encoded NUL bytes
  if (requestPath.includes("\0") || /%00/i.test(requestPath)) {
    return null;
  }

  // 2. Decode percent-encoded components safely
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  // Check again after decoding for NUL bytes
  if (decoded.includes("\0")) {
    return null;
  }

  // Convert backslashes to forward slashes
  const normalized = decoded.replace(/\\/g, "/");

  // 3. Reject paths containing ".." segments
  const rawSegments = normalized.split("/");
  for (const seg of rawSegments) {
    if (seg === ".." || (seg.startsWith(".") && seg === "..")) {
      return null;
    }
  }

  // Filter out empty segments and single dots
  const validSegments = rawSegments.filter((seg) => seg !== "" && seg !== ".");
  if (validSegments.length === 0) {
    return null;
  }

  // Check if any segment attempts directory traversal
  for (const seg of validSegments) {
    if (seg === ".." || seg.includes("\0")) {
      return null;
    }
  }

  // 4. Extension check against allowlist
  const fileName = validSegments[validSegments.length - 1]!;
  if (!fileName.includes(".")) {
    return null;
  }
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  if (!ALLOWED_STATIC_EXTENSIONS.has(ext)) {
    return null;
  }

  // 5. Build clean contained path
  const cleanBase = webDist.replace(/\\/g, "/").replace(/\/+$/, "");
  const cleanRelative = validSegments.join("/");

  // Ensure resolved path starts strictly with the cleanBase directory prefix
  const resolved = `${cleanBase}/${cleanRelative}`;
  if (!resolved.startsWith(`${cleanBase}/`)) {
    return null;
  }

  return resolved;
}
