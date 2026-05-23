import * as fs from "node:fs/promises";
import * as path from "node:path";
import { jsonSchema, tool } from "ai";
const WORKSPACE_ROOT = path.resolve(process.cwd());

export const readFileTool = tool({
  description: "读取指定路径的文件内容，返回文本内容",
  inputSchema: jsonSchema<{ filePath: string; offset?: number; limit?: number }>({
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "要读取的文件路径（相对于工作目录）",
      },
      offset: {
        type: "number",
        description: "起始行号（从 1 开始），不传则从头读取",
      },
      limit: {
        type: "number",
        description: "最多读取的行数，不传则读取全部",
      },
    },
    required: ["filePath"],
  }),
});

export async function executeReadFile(input: {
  filePath: string;
  offset?: number;
  limit?: number;
}) {
  const resolved = path.resolve(WORKSPACE_ROOT, input.filePath);

  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    return { error: `不允许访问工作目录之外的文件: ${input.filePath}` };
  }

  try {
    const content = await fs.readFile(resolved, "utf-8");
    const lines = content.split("\n");

    const start = input.offset ? input.offset - 1 : 0;
    const end = input.limit ? start + input.limit : lines.length;
    const sliced = lines.slice(start, end);

    return {
      path: input.filePath,
      totalLines: lines.length,
      lines: sliced,
      content: sliced.join("\n"),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { error: `文件不存在: ${input.filePath}` };
    }
    if ((err as NodeJS.ErrnoException).code === "EISDIR") {
      return { error: `路径是目录，不是文件: ${input.filePath}` };
    }
    return { error: `读取失败: ${message}` };
  }
}

import type { ToolDefinition } from "./index";

export const readFileConfig = {
  name: "read_file",
  description: "读取指定路径的文件内容，返回文本内容。支持分页读取（offset + limit）",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "要读取的文件路径（相对于工作目录）" },
      offset: { type: "number", description: "起始行号（从 1 开始），不传则从头读取" },
      limit: { type: "number", description: "最多读取的行数，不传则读取全部" },
    },
    required: ["filePath"],
  },
  execute: (input: any) =>
    executeReadFile(input as { filePath: string; offset?: number; limit?: number }),
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 500,
  schema: readFileTool,
} satisfies ToolDefinition & { schema: unknown };
