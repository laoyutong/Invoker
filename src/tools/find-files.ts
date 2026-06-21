import * as fs from "node:fs/promises";
import * as path from "node:path";
import { jsonSchema, tool } from "ai";
import { resolveWorkspacePath, WORKSPACE_ROOT } from "../path-utils";
import type { ToolDefinition } from "./index";

export const findFilesTool = tool({
  description: "在指定目录下搜索匹配模式的文件或子目录，返回匹配项的路径列表",
  inputSchema: jsonSchema<{
    dirPath?: string;
    pattern?: string;
    type?: "file" | "directory" | "all";
  }>({
    type: "object",
    properties: {
      dirPath: {
        type: "string",
        description: "搜索的起始目录（相对于工作目录），默认为工作目录根",
      },
      pattern: {
        type: "string",
        description: "文件名匹配模式（大小写不敏感），支持通配符 *，如 *.ts、test*。不传则返回所有",
      },
      type: {
        type: "string",
        enum: ["file", "directory", "all"],
        description: "只返回文件、只返回目录，还是都返回。默认为 all",
      },
    },
    required: [],
  }),
});

function matchPattern(name: string, pattern: string): boolean {
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${regexStr}$`, "i");
  return regex.test(name);
}

async function walkEntries(
  dir: string,
  typeFilter: "file" | "directory" | "all",
  pattern?: string,
): Promise<{ name: string; relativePath: string; type: "file" | "directory" }[]> {
  const results: { name: string; relativePath: string; type: "file" | "directory" }[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const fullPath = path.join(dir, entry.name);
    const entryType = entry.isDirectory() ? "directory" : "file";

    if (
      (typeFilter === "all" || entryType === typeFilter) &&
      (!pattern || matchPattern(entry.name, pattern))
    ) {
      results.push({
        name: entry.name,
        relativePath: path.relative(WORKSPACE_ROOT, fullPath),
        type: entryType,
      });
    }

    if (entry.isDirectory()) {
      results.push(...(await walkEntries(fullPath, typeFilter, pattern)));
    }
  }

  return results;
}

export async function executeFindFiles(input: {
  dirPath?: string;
  pattern?: string;
  type?: "file" | "directory" | "all";
}) {
  const searchDir = input.dirPath || ".";
  const resolved = resolveWorkspacePath(searchDir);

  if (!resolved.ok) {
    return { error: `不允许搜索工作目录之外的位置: ${resolved.error}` };
  }

  try {
    const typeFilter = input.type || "all";
    const results = await walkEntries(resolved.path, typeFilter, input.pattern);

    return {
      dir: searchDir,
      count: results.length,
      results,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { error: `目录不存在: ${searchDir}` };
    }
    return { error: `搜索失败: ${message}` };
  }
}

export const findFilesConfig = {
  name: "find_files",
  description:
    "在指定目录下搜索匹配模式的文件或子目录，返回匹配项的路径列表。" + "支持通配符 *，大小写不敏感",
  parameters: {
    type: "object",
    properties: {
      dirPath: {
        type: "string",
        description: "搜索的起始目录（相对于工作目录），默认为工作目录根",
      },
      pattern: {
        type: "string",
        description: "文件名匹配模式，支持通配符 *，如 *.ts、test*。不传则返回所有",
      },
      type: {
        type: "string",
        enum: ["file", "directory", "all"],
        description: "只返回文件、只返回目录，还是都返回。默认为 all",
      },
    },
    required: [],
  },
  execute: (input: unknown) =>
    executeFindFiles(
      input as { dirPath?: string; pattern?: string; type?: "file" | "directory" | "all" },
    ),
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 3000,
  shouldDefer: true,
  searchHint: "查找文件 目录列表 列出文件",
  schema: findFilesTool,
} satisfies ToolDefinition & { schema: unknown };
