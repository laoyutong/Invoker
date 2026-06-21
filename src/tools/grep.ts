import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { jsonSchema, tool } from "ai";
import { resolveWorkspacePath, WORKSPACE_ROOT } from "../path-utils";
import type { ToolDefinition } from "./index";

export const grepTool = tool({
  description:
    "在文件内容中搜索正则表达式模式。支持递归目录搜索、" + "文件名过滤、上下文行、多种输出模式。",
  inputSchema: jsonSchema<{
    pattern: string;
    searchPath?: string;
    include?: string;
    output_mode?: "content" | "files_with_matches" | "count";
    "-i"?: boolean;
    "-n"?: boolean;
    "-A"?: number;
    "-B"?: number;
    "-C"?: number;
    head_limit?: number;
    multiline?: boolean;
  }>({
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "正则表达式搜索模式",
      },
      searchPath: {
        type: "string",
        description: "搜索路径（文件或目录），相对于工作目录，默认为工作目录根",
      },
      include: {
        type: "string",
        description: "文件名 glob 过滤器，如 *.ts，仅搜索匹配的文件",
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description:
          "输出模式：content 显示匹配行及上下文，files_with_matches 仅文件路径，count 匹配数。默认 content",
      },
      "-i": {
        type: "boolean",
        description: "大小写不敏感搜索",
      },
      "-n": {
        type: "boolean",
        description: "在输出中显示行号",
      },
      "-A": {
        type: "number",
        description: "匹配行之后显示的上下文行数",
      },
      "-B": {
        type: "number",
        description: "匹配行之前显示的上下文行数",
      },
      "-C": {
        type: "number",
        description: "匹配行前后显示的上下文行数",
      },
      head_limit: {
        type: "number",
        description: "最多返回的结果行/文件数，默认 250",
      },
      multiline: {
        type: "boolean",
        description: "多行模式，. 匹配换行符",
      },
    },
    required: ["pattern"],
  }),
});

const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg"]);

async function* walkFiles(
  root: string,
  includeGlob?: string,
): AsyncGenerator<{ fullPath: string; relativePath: string }> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  const subdirs: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(root, entry.name);
    const relativePath = path.relative(WORKSPACE_ROOT, fullPath);

    if (entry.isFile()) {
      if (includeGlob && !matchGlob(entry.name, includeGlob)) continue;
      yield { fullPath, relativePath };
    } else if (entry.isDirectory()) {
      subdirs.push(fullPath);
    }
  }

  for (const subdir of subdirs) {
    yield* walkFiles(subdir, includeGlob);
  }
}

function matchGlob(name: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`, "i").test(name);
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.slice(0, 8192);
  return sample.includes(0);
}

export async function executeGrep(input: {
  pattern: string;
  searchPath?: string;
  include?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean;
  "-n"?: boolean;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  head_limit?: number;
  multiline?: boolean;
}) {
  const searchDir = input.searchPath || ".";
  const resolved = resolveWorkspacePath(searchDir);

  if (!resolved.ok) {
    return { error: `不允许搜索工作目录之外的位置: ${resolved.error}` };
  }

  let flags = "g";
  if (input["-i"]) flags += "i";
  if (input.multiline) flags += "s";

  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, flags);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `无效的正则表达式: ${message}` };
  }

  const outputMode = input.output_mode || "content";
  const headLimit = input.head_limit ?? 250;
  const contextBefore = input["-B"] ?? input["-C"] ?? 0;
  const contextAfter = input["-A"] ?? input["-C"] ?? 0;

  type GrepResult =
    | {
        file: string;
        type: "content";
        matches: {
          line: number;
          text: string;
          contextBefore?: string[];
          contextAfter?: string[];
        }[];
      }
    | { file: string; type: "files_with_matches" }
    | { file: string; type: "count"; matchCount: number };

  const results: GrepResult[] = [];

  try {
    const stat = await fs.stat(resolved.path);

    if (stat.isFile()) {
      const relativePath = path.relative(WORKSPACE_ROOT, resolved.path);
      const result = await searchFile(
        resolved.path,
        relativePath,
        regex,
        outputMode,
        contextBefore,
        contextAfter,
        input.multiline ?? false,
      );
      if (result) results.push(result as GrepResult);
    } else {
      let totalMatches = 0;
      for await (const { fullPath, relativePath } of walkFiles(resolved.path, input.include)) {
        if (totalMatches >= headLimit && outputMode === "files_with_matches") break;

        const result = await searchFile(
          fullPath,
          relativePath,
          regex,
          outputMode,
          contextBefore,
          contextAfter,
          input.multiline ?? false,
        );
        if (result) {
          results.push(result as GrepResult);

          if (outputMode === "content") {
            const matchCount = "matches" in result ? (result.matches?.length ?? 0) : 0;
            totalMatches += matchCount;
            if (totalMatches >= headLimit) break;
          } else if (outputMode === "files_with_matches") {
            totalMatches++;
          } else if (outputMode === "count") {
            totalMatches++;
            if (totalMatches >= headLimit) break;
          }
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { error: `路径不存在: ${searchDir}` };
    }
    return { error: `搜索失败: ${message}` };
  }

  return {
    pattern: input.pattern,
    outputMode,
    count: results.length,
    results,
  };
}

async function searchFile(
  fullPath: string,
  relativePath: string,
  regex: RegExp,
  outputMode: "content" | "files_with_matches" | "count",
  contextBefore: number,
  contextAfter: number,
  multiline: boolean,
): Promise<{
  file: string;
  type: "content" | "files_with_matches" | "count";
  matches?: { line: number; text: string; contextBefore?: string[]; contextAfter?: string[] }[];
  matchCount?: number;
} | null> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(fullPath);
  } catch {
    return null;
  }

  if (isBinary(buffer)) return null;

  const content = buffer.toString("utf-8");
  const lines = content.split("\n");

  if (multiline) {
    const matches: { line: number; text: string }[] = [];
    const fullTextRegex = new RegExp(
      regex.source,
      regex.flags.includes("g") ? regex.flags : `${regex.flags}g`,
    );
    let match = fullTextRegex.exec(content);
    while (match !== null) {
      const line = content.slice(0, match.index).split("\n").length;
      matches.push({ line, text: match[0] });

      if (match[0].length === 0) {
        fullTextRegex.lastIndex++;
      }

      match = fullTextRegex.exec(content);
    }

    return formatSearchResult(
      relativePath,
      outputMode,
      lines,
      matches,
      contextBefore,
      contextAfter,
    );
  }

  const flags = regex.flags.includes("s")
    ? `g${regex.flags.replace("s", "").replace("g", "")}`
    : regex.flags.replace("g", "");

  const matches: { line: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const testRegex = new RegExp(regex.source, flags);
    if (testRegex.test(lines[i])) {
      matches.push({ line: i + 1, text: lines[i] });
    }
  }

  return formatSearchResult(relativePath, outputMode, lines, matches, contextBefore, contextAfter);
}

function formatSearchResult(
  relativePath: string,
  outputMode: "content" | "files_with_matches" | "count",
  lines: string[],
  matches: { line: number; text: string }[],
  contextBefore: number,
  contextAfter: number,
): {
  file: string;
  type: "content" | "files_with_matches" | "count";
  matches?: { line: number; text: string; contextBefore?: string[]; contextAfter?: string[] }[];
  matchCount?: number;
} | null {
  if (matches.length === 0) return null;

  if (outputMode === "count") {
    return { file: relativePath, type: "count", matchCount: matches.length };
  }

  if (outputMode === "files_with_matches") {
    return { file: relativePath, type: "files_with_matches" };
  }

  const resultMatches: {
    line: number;
    text: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }[] = [];

  for (const m of matches) {
    const matchEntry: (typeof resultMatches)[0] = {
      line: m.line,
      text: m.text,
    };
    if (contextBefore > 0) {
      const start = Math.max(0, m.line - 1 - contextBefore);
      matchEntry.contextBefore = lines.slice(start, m.line - 1);
    }
    if (contextAfter > 0) {
      const end = Math.min(lines.length, m.line + contextAfter);
      matchEntry.contextAfter = lines.slice(m.line, end);
    }
    resultMatches.push(matchEntry);
  }

  return {
    file: relativePath,
    type: "content",
    matches: resultMatches,
  };
}

export const grepConfig = {
  name: "grep",
  description:
    "在文件内容中搜索正则表达式模式。支持递归目录搜索、" +
    "文件名 glob 过滤、上下文行、多种输出模式。" +
    "类似 ripgrep/grep 功能。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式搜索模式" },
      searchPath: { type: "string", description: "搜索路径（文件或目录），默认为工作目录根" },
      include: { type: "string", description: "文件名 glob 过滤器，如 *.ts" },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "输出模式",
      },
      "-i": { type: "boolean", description: "大小写不敏感" },
      "-n": { type: "boolean", description: "显示行号" },
      "-A": { type: "number", description: "匹配行之后的上下文行数" },
      "-B": { type: "number", description: "匹配行之前的上下文行数" },
      "-C": { type: "number", description: "匹配行前后的上下文行数" },
      head_limit: { type: "number", description: "结果上限，默认 250" },
      multiline: { type: "boolean", description: "多行模式" },
    },
    required: ["pattern"],
  },
  execute: (input: unknown) =>
    executeGrep(
      input as {
        pattern: string;
        searchPath?: string;
        include?: string;
        output_mode?: "content" | "files_with_matches" | "count";
        "-i"?: boolean;
        "-n"?: boolean;
        "-A"?: number;
        "-B"?: number;
        "-C"?: number;
        head_limit?: number;
        multiline?: boolean;
      },
    ),
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 8000,
  schema: grepTool,
} satisfies ToolDefinition & { schema: unknown };
