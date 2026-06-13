import * as fs from "node:fs/promises";
import * as path from "node:path";
import { jsonSchema, tool } from "ai";
import { resolveWorkspacePath } from "../path-utils";
import type { ToolDefinition } from "./index";

export const writeFileTool = tool({
  description: "将内容写入指定文件，如果文件已存在则覆盖",
  inputSchema: jsonSchema<{ filePath: string; content: string }>({
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "要写入的文件路径（相对于工作目录）",
      },
      content: {
        type: "string",
        description: "要写入的文件内容",
      },
    },
    required: ["filePath", "content"],
  }),
});

export async function executeWriteFile(input: { filePath: string; content: string }) {
  const resolved = resolveWorkspacePath(input.filePath);

  if (!resolved.ok) {
    return { error: `不允许写入工作目录之外的文件: ${resolved.error}` };
  }

  try {
    await fs.mkdir(path.dirname(resolved.path), { recursive: true });
    await fs.writeFile(resolved.path, input.content, "utf-8");
    return {
      path: input.filePath,
      written: input.content.length,
      status: "ok",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `写入失败: ${message}` };
  }
}

export const writeFileConfig = {
  name: "write_file",
  description: "将内容写入指定文件，如果文件已存在则覆盖。自动创建不存在的父目录",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "要写入的文件路径（相对于工作目录）" },
      content: { type: "string", description: "要写入的文件内容" },
    },
    required: ["filePath", "content"],
  },
  execute: (input: unknown) => executeWriteFile(input as { filePath: string; content: string }),
  isReadOnly: false,
  isConcurrencySafe: false,
  maxResultChars: 200,
  schema: writeFileTool,
} satisfies ToolDefinition & { schema: unknown };
