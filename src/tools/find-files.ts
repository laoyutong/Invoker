import * as fs from "node:fs/promises";
import * as path from "node:path";
import { jsonSchema, tool } from "ai";
import type { ToolDefinition } from "./index";

const WORKSPACE_ROOT = path.resolve(process.cwd());

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

export async function executeFindFiles(input: {
  dirPath?: string;
  pattern?: string;
  type?: "file" | "directory" | "all";
}) {
  const searchDir = input.dirPath || ".";
  const resolved = path.resolve(WORKSPACE_ROOT, searchDir);

  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    return { error: `不允许搜索工作目录之外的位置: ${searchDir}` };
  }

  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const typeFilter = input.type || "all";

    let results: { name: string; relativePath: string; type: "file" | "directory" }[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const entryType = entry.isDirectory() ? "directory" : "file";

      if (typeFilter !== "all" && entryType !== typeFilter) continue;

      if (input.pattern && !matchPattern(entry.name, input.pattern)) continue;

      results.push({
        name: entry.name,
        relativePath: path.relative(WORKSPACE_ROOT, path.join(resolved, entry.name)),
        type: entryType,
      });
    }

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
  execute: (input: any) =>
    executeFindFiles(
      input as { dirPath?: string; pattern?: string; type?: "file" | "directory" | "all" },
    ),
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 3000,
  schema: findFilesTool,
} satisfies ToolDefinition & { schema: unknown };
