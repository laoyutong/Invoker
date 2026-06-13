import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { jsonSchema, tool } from "ai";
import { resolveWorkspacePath } from "../path-utils";
import type { ToolDefinition } from "./index";

export const globTool = tool({
  description:
    "按 glob 模式递归搜索文件，返回匹配的文件路径列表，按修改时间降序排列。" +
    "模式: ** 匹配任意多级目录，* 匹配除 / 外的任意字符，? 匹配单个字符。",
  inputSchema: jsonSchema<{ pattern: string; basePath?: string }>({
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob 模式，如 "**/*.ts"、"src/**/*.tsx"、"*.json"',
      },
      basePath: {
        type: "string",
        description: "搜索起始目录（相对于工作目录），默认为工作目录根",
      },
    },
    required: ["pattern"],
  }),
});

function globToRegex(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < pattern.length) {
    if (pattern[i] === "*") {
      if (pattern[i + 1] === "*") {
        // ** 匹配任意多级目录（包括零级）
        if (pattern[i + 2] === "/") {
          regexStr += "(.*/)?";
          i += 3;
          continue;
        }
        // 孤立的 **（末尾或后面没有 /），匹配任意字符包括 /
        regexStr += ".*";
        i += 2;
        continue;
      }
      // 单个 * 不匹配 /
      regexStr += "[^/]*";
      i++;
      continue;
    }
    if (pattern[i] === "?") {
      regexStr += "[^/]";
      i++;
      continue;
    }
    // 转义正则特殊字符
    if (/[.+^${}()|[\]\\]/.test(pattern[i])) {
      regexStr += `\\${pattern[i]}`;
    } else {
      regexStr += pattern[i];
    }
    i++;
  }

  // 如果模式不以 ** 开头且不以 / 开头，只匹配当前目录级别（非递归）
  if (!pattern.startsWith("**")) {
    return new RegExp(`^${regexStr}$`);
  }
  return new RegExp(`^${regexStr}$`);
}

async function walkDir(
  dir: string,
  basePath: string,
): Promise<{ relativePath: string; mtime: Date }[]> {
  const results: { relativePath: string; mtime: Date }[] = [];

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results; // 跳过无法读取的目录
  }

  const subdirs: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (entry.isFile()) {
      try {
        const stat = await fs.stat(fullPath);
        results.push({ relativePath, mtime: stat.mtime });
      } catch {
        results.push({ relativePath, mtime: new Date(0) });
      }
    } else if (entry.isDirectory()) {
      subdirs.push(fullPath);
    }
  }

  // 递归进入子目录
  for (const subdir of subdirs) {
    const subResults = await walkDir(subdir, basePath);
    results.push(...subResults);
  }

  return results;
}

export async function executeGlob(input: { pattern: string; basePath?: string }) {
  const base = resolveWorkspacePath(input.basePath || ".");
  if (!base.ok) {
    return { error: `不允许搜索工作目录之外的位置: ${base.error}` };
  }

  try {
    const allFiles = await walkDir(base.path, base.path);
    const regex = globToRegex(input.pattern);

    const matched = allFiles.filter((f) => regex.test(f.relativePath));
    matched.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return {
      pattern: input.pattern,
      basePath: input.basePath || ".",
      count: matched.length,
      results: matched.map((f) => ({
        path: f.relativePath,
        mtime: f.mtime.toISOString(),
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `搜索失败: ${message}` };
  }
}

export const globConfig = {
  name: "glob",
  description:
    "按 glob 模式递归搜索文件，返回匹配的文件路径列表，按修改时间降序排列。" +
    "模式: ** 匹配任意多级目录，* 匹配除 / 外的任意字符。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'Glob 模式，如 "**/*.ts"、"src/**/*.tsx"、"*.json"' },
      basePath: { type: "string", description: "搜索起始目录（相对于工作目录），默认为工作目录根" },
    },
    required: ["pattern"],
  },
  execute: (input: unknown) => executeGlob(input as { pattern: string; basePath?: string }),
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 5000,
  schema: globTool,
} satisfies ToolDefinition & { schema: unknown };
