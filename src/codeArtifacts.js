const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\n]*?)\r?$/;
const FENCE_CLOSE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*\r?$/;
const FILE_MARKER_RE = /\b(?:file|filename)\s*:\s*[`"'*]*([^\s`"'*]+)/gi;
const PATH_TOKEN_RE = /(?:^|\s)([^\s`"']+\.[a-z0-9]{1,12})(?=\s|$)/i;
const INFO_FILE_RE = /(?:filename|file|title|name)\s*=\s*["']?([^"'\s]+)/i;
const KNOWN_LANGS = new Set([
  "html", "htm", "css", "js", "javascript", "mjs", "cjs", "jsx", "ts", "typescript",
  "tsx", "json", "svg", "xml", "md", "markdown", "py", "python", "java", "kotlin",
  "swift", "c", "cpp", "cs", "go", "rs", "rust", "php", "sql", "yml", "yaml",
  "toml", "ini"
]);
const EXTENSIONS = {
  html: "html", htm: "html", css: "css", js: "js", javascript: "js", mjs: "mjs",
  cjs: "cjs", jsx: "jsx", ts: "ts", typescript: "ts", tsx: "tsx", json: "json",
  svg: "svg", xml: "xml", md: "md", markdown: "md", py: "py", python: "py",
  java: "java", kotlin: "kt", swift: "swift", c: "c", cpp: "cpp", cs: "cs",
  go: "go", rs: "rs", rust: "rs", php: "php", sql: "sql", sh: "sh", bash: "sh",
  yml: "yml", yaml: "yml", toml: "toml", ini: "ini", txt: "txt"
};
const DEFAULT_NAMES = {
  html: "index.html", htm: "index.html", css: "styles.css", js: "script.js",
  javascript: "script.js", mjs: "script.mjs", cjs: "script.cjs", jsx: "App.jsx",
  ts: "script.ts", typescript: "script.ts", tsx: "App.tsx", json: "data.json",
  svg: "image.svg", xml: "document.xml", md: "document.md", markdown: "document.md",
  py: "main.py", python: "main.py", java: "Main.java", kotlin: "Main.kt",
  swift: "main.swift", c: "main.c", cpp: "main.cpp", cs: "Program.cs", go: "main.go",
  rs: "main.rs", rust: "main.rs", php: "index.php", sql: "query.sql", sh: "script.sh",
  bash: "script.sh", yml: "config.yml", yaml: "config.yml", toml: "config.toml",
  ini: "config.ini", txt: "file.txt"
};

function envLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function artifactLimits() {
  return {
    maxFiles: envLimit("ARTIFACT_MAX_FILES", 40),
    maxFileChars: envLimit("ARTIFACT_MAX_FILE_CHARS", 500_000),
    maxTotalChars: envLimit("ARTIFACT_MAX_TOTAL_CHARS", 1_500_000),
    maxSummaryChars: envLimit("ARTIFACT_MAX_SUMMARY_CHARS", 8_000),
    maxContinuationContextChars: envLimit("ARTIFACT_CONTINUATION_CONTEXT_CHARS", 120_000)
  };
}

export class ArtifactError extends Error {
  constructor(message, code = "invalid_artifact") {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
  }
}

function cleanInfo(info) {
  return typeof info === "string" ? info.trim().replace(/^\{\.?|^\s*/, "") : "";
}

function filenameFromInfo(info) {
  const value = cleanInfo(info);
  if (!value) return "";
  const named = INFO_FILE_RE.exec(value)?.[1];
  if (named) return named;
  const languagePath = /^[a-z0-9+#-]+:([^\s]+)$/i.exec(value)?.[1];
  if (languagePath) return languagePath;
  return PATH_TOKEN_RE.exec(value)?.[1] || "";
}

function filenameNear(text) {
  const tail = typeof text === "string" ? text.split("\n").slice(-10).join("\n") : "";
  let match;
  let marker = "";
  FILE_MARKER_RE.lastIndex = 0;
  while ((match = FILE_MARKER_RE.exec(tail))) marker = match[1];
  if (marker) return marker;

  const lines = tail.split("\n").map(line => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    const heading = /^#{1,6}\s+[`"']?([^\s`"']+)[`"']?\s*$/.exec(line);
    if (heading) return heading[1];
    const bold = /^(?:\*\*|__)[`"']?([^\s`"']+)[`"']?(?:\*\*|__)\s*:?\s*$/.exec(line);
    if (bold) return bold[1];
    const quoted = /^[`"']([^`"'\s]+\.[a-z0-9]{1,12})[`"']\s*:?\s*$/i.exec(line);
    if (quoted) return quoted[1];
    const plain = /^([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*\.[a-z0-9]{1,12})\s*:?\s*$/i.exec(line);
    if (plain) return plain[1];
  }
  return "";
}

function trimSegment(segment) {
  return segment
    .replace(/[\u0000-\u001f<>:"|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

export function safeFilePath(input, fallback = "") {
  let value = typeof input === "string" ? input.trim().replace(/\\/g, "/") : "";
  if (!value) value = fallback;
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.endsWith("/")) return null;
  value = value.replace(/^[a-zA-Z]:\/?/, "").replace(/^\/+/, "");
  const parts = [];
  for (const raw of value.split("/")) {
    if (!raw || raw === "." || raw === "..") {
      if (raw === "..") return null;
      continue;
    }
    let segment = trimSegment(raw);
    if (!segment) continue;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) segment = `_${segment}`;
    if (segment.length > 100) {
      const dot = segment.lastIndexOf(".");
      const ext = dot > 0 ? segment.slice(dot) : "";
      segment = `${segment.slice(0, Math.max(1, 100 - ext.length))}${ext}`;
    }
    parts.push(segment);
  }
  if (parts.length === 0) return null;
  const path = parts.join("/");
  return path.length <= 180 ? path : null;
}

function uniquePath(path, used) {
  if (!used.has(path.toLowerCase())) {
    used.add(path.toLowerCase());
    return path;
  }
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${dir}${base}-${i}${ext}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
  return null;
}

function fenceBlocks(markdown) {
  const text = String(markdown || "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks = [];
  let lastEnd = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE_OPEN_RE.exec(lines[index]);
    if (!open) continue;
    const marker = open[1];
    const info = open[2] || "";
    let close = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = FENCE_CLOSE_RE.exec(lines[scan]);
      if (candidate && candidate[1][0] === marker[0] && candidate[1].length >= marker.length) {
        close = scan;
        break;
      }
    }
    blocks.push({
      info,
      startLine: index,
      endLine: close,
      preceding: lines.slice(lastEnd, index).join("\n"),
      content: lines.slice(index + 1, close === -1 ? lines.length : close).join("\n")
    });
    if (close === -1) break;
    index = close;
    lastEnd = close + 1;
  }
  return { lines, blocks };
}

export function extractCodeFiles(markdown, { includeUnclosed = false } = {}) {
  if (typeof markdown !== "string" || !markdown.trim()) return [];
  const { blocks } = fenceBlocks(markdown);
  const files = [];
  const used = new Set();

  for (const block of blocks) {
    if (block.endLine === -1 && !includeUnclosed) continue;
    const info = cleanInfo(block.info);
    const lang = info.split(/\s+/)[0].toLowerCase().replace(/^language-/, "").replace(/[^\w+-]/g, "");
    const closed = block.endLine !== -1;
    const content = closed ? `${block.content}\n` : block.content;
    if (!content.trim()) continue;

    const explicitName = filenameFromInfo(info) || filenameNear(block.preceding);
    if (!explicitName && !KNOWN_LANGS.has(lang)) continue;
    const fallback = DEFAULT_NAMES[lang] || `code-${files.length + 1}.txt`;
    const path = safeFilePath(explicitName, fallback);
    if (!path) continue;
    const unique = uniquePath(path, used);
    if (!unique) continue;
    files.push({
      path: unique,
      content,
      language: lang || EXTENSIONS[unique.split(".").pop()?.toLowerCase()] || "",
      bytes: Buffer.byteLength(content, "utf8"),
      explicit: Boolean(explicitName),
      complete: closed
    });
  }

  return files;
}

function stripCodeFences(markdown) {
  const { lines, blocks } = fenceBlocks(markdown);
  const removed = new Set();
  for (const block of blocks) {
    removed.add(block.startLine);
    if (block.endLine === -1) {
      for (let index = block.startLine + 1; index < lines.length; index += 1) removed.add(index);
    } else {
      for (let index = block.startLine; index <= block.endLine; index += 1) removed.add(index);
    }
  }
  return lines
    .filter((_, index) => !removed.has(index))
    .join("\n")
    .replace(/^[ \t]*FILE:\s*\S+[ \t]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isWebsitePackage(files) {
  return Array.isArray(files) && files.length > 1 && files.some(file => /\.html?$/i.test(file.path));
}

export function shouldCreateArtifact(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  const chars = files.reduce((total, file) => total + file.content.length, 0);
  if (isWebsitePackage(files)) return true;
  if (files.length >= 2 && (files.some(file => file.explicit) || chars >= 1200)) return true;
  return files.length === 1 && chars >= 3000;
}

export function responseSummary(markdown, files) {
  const limits = artifactLimits();
  let summary = stripCodeFences(markdown);
  if (summary.length > limits.maxSummaryChars) {
    summary = `${summary.slice(0, limits.maxSummaryChars).replace(/\s+\S*$/, "")}â€¦`;
  }
  if (summary) return summary;
  if (!files?.length) return "";
  if (files.length === 1) return `Generated ${files[0].path}.`;
  return `Generated a project with ${files.length} files.`;
}

export function validateArtifactFiles(files) {
  const limits = artifactLimits();
  if (!Array.isArray(files) || files.length === 0) {
    throw new ArtifactError("No generated source files were found.", "invalid_artifact");
  }
  if (files.length > limits.maxFiles) {
    throw new ArtifactError(`This response contains more than ${limits.maxFiles} files. Ask for a smaller project or fewer files.`, "artifact_too_many_files");
  }
  let total = 0;
  for (const file of files) {
    if (typeof file.content !== "string" || !file.content.length) {
      throw new ArtifactError(`The generated file ${file.path} is empty.`, "invalid_artifact");
    }
    if (file.content.length > limits.maxFileChars) {
      throw new ArtifactError(
        `${file.path} exceeds the ${limits.maxFileChars.toLocaleString()}-character limit for one saved file. Copy it from this response or ask for a smaller file.`,
        "artifact_too_large"
      );
    }
    total += file.content.length;
    if (total > limits.maxTotalChars) {
      throw new ArtifactError(
        `This project exceeds the ${limits.maxTotalChars.toLocaleString()}-character limit for saved code. Copy the files from this response or split the project into smaller parts.`,
        "artifact_too_large"
      );
    }
  }
  return files;
}

export function buildCodeArtifact(markdown, { status = "complete", finishReason = null } = {}) {
  const files = extractCodeFiles(markdown, { includeUnclosed: status !== "complete" });
  if (!shouldCreateArtifact(files)) return null;
  validateArtifactFiles(files);
  const normalized = files.map((file, index) => ({
    ...file,
    complete: status === "complete" || index < files.length - 1
  }));
  return {
    files: normalized,
    summary: responseSummary(markdown, normalized),
    status,
    finishReason
  };
}

function cleanAddition(text, targetPath) {
  const parsed = extractCodeFiles(text, { includeUnclosed: true });
  if (parsed.length > 0) {
    const match = parsed.find(file => file.path === targetPath);
    const file = match || parsed[parsed.length - 1];
    return file.content.replace(/\r\n?/g, "\n");
  }
  return String(text || "")
    .replace(/^\s*```[^\n]*\n/, "")
    .replace(/\n```\s*$/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

export function mergeContinuation(base, addition, targetPath = "") {
  const original = String(base || "");
  let next = cleanAddition(addition, targetPath);
  if (!next) return original;
  if (original && next.includes(original) && original.length > 40) return next;

  const maxOverlap = Math.min(4000, original.length, next.length);
  for (let size = maxOverlap; size >= 20; size -= 1) {
    if (original.slice(-size) === next.slice(0, size)) {
      next = next.slice(size);
      break;
    }
  }
  if (!next) return original;
  
  return `${original}${next}`;
}

export function continuationPlan(artifact) {
  const files = Array.isArray(artifact?.files) ? artifact.files : [];
  if (files.length === 0) {
    throw new ArtifactError("There is no saved code to continue. Retry the request instead.", "continuation_unavailable");
  }
  let targetIndex = files.findIndex(file => file.complete === false);
  if (targetIndex === -1) targetIndex = files.length - 1;
  const target = files[targetIndex];
  const limits = artifactLimits();
  const content = String(target.content || "");
  const excerpt = content.length > limits.maxContinuationContextChars
    ? `[Earlier content omitted because the file is long.]\n${content.slice(-limits.maxContinuationContextChars)}`
    : content;
  const fileList = files.map(file => file.path).join(", ");
  const prompt = [
    `Continue the incomplete file "${target.path}" exactly from where it stopped.`,
    `The project contains these files: ${fileList}.`,
    "Return only the missing source code. Do not repeat any existing code, do not restart the file, do not add markdown fences, and do not add commentary.",
    "Preserve the existing style, indentation, and syntax. End at a natural code boundary if possible.",
    "",
    `--- BEGIN EXISTING ${target.path} ---`,
    excerpt,
    `--- END EXISTING ${target.path} ---`
  ].join("\n");
  return { targetIndex, targetPath: target.path, prompt };
}

export function applyContinuationFile(artifact, targetPath, addition, { complete = true } = {}) {
  const files = Array.isArray(artifact?.files) ? artifact.files.map(file => ({ ...file })) : [];
  const index = files.findIndex(file => file.path === targetPath);
  if (index === -1) {
    throw new ArtifactError("The saved file could not be found for continuation.", "continuation_unavailable");
  }
  const target = files[index];
  target.content = mergeContinuation(target.content, addition, targetPath);
  target.bytes = Buffer.byteLength(target.content, "utf8");
  target.complete = complete;
  validateArtifactFiles(files);
  return { files, file: files[index] };
}
