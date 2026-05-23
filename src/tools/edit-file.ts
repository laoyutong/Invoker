import * as fs from "node:fs/promises";
import * as path from "node:path";
import { jsonSchema, tool } from "ai";
import type { ToolDefinition } from "./index";

const WORKSPACE_ROOT = path.resolve(process.cwd());

export const editFileTool = tool({
  description:
    "在文件中精确替换文本。找到 old_string 的（唯一）出现并替换为 new_string。" +
    "如果 old_string 不唯一，需要使用 replace_all 标志来替换所有出现，或者提供更多上下文使匹配唯一。",
  inputSchema: jsonSchema<{
    filePath: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }>({
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "要编辑的文件路径（相对于工作目录）",
      },
      old_string: {
        type: "string",
        description: "要被替换的原文本，必须精确匹配",
      },
      new_string: {
        type: "string",
        description: "替换后的新文本",
      },
      replace_all: {
        type: "boolean",
        description: "是否替换所有出现。默认 false，此时 old_string 必须唯一",
      },
    },
    required: ["filePath", "old_string", "new_string"],
  }),
});

export async function executeEditFile(input: {
  filePath: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}) {
  const resolved = path.resolve(WORKSPACE_ROOT, input.filePath);

  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    return { error: `不允许编辑工作目录之外的文件: ${input.filePath}` };
  }

  let content: string;
  try {
    content = await fs.readFile(resolved, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { error: `文件不存在: ${input.filePath}` };
    }
    return { error: `读取文件失败: ${message}` };
  }

  if (input.old_string === input.new_string) {
    return { error: "old_string 和 new_string 相同，无需替换" };
  }

  if (!input.old_string) {
    return { error: "old_string 不能为空" };
  }

  if (input.replace_all) {
    const count = content.split(input.old_string).length - 1;
    if (count === 0) {
      return { error: `未找到匹配的文本: "${input.old_string.slice(0, 80)}"` };
    }
    const newContent = content.replaceAll(input.old_string, input.new_string);
    await fs.writeFile(resolved, newContent, "utf-8");
    return {
      path: input.filePath,
      replacements: count,
      status: "ok",
    };
  }

  // 非 replace_all 模式：old_string 必须唯一
  const occurrences: number[] = [];
  let idx = content.indexOf(input.old_string);
  while (idx !== -1) {
    occurrences.push(idx);
    idx = content.indexOf(input.old_string, idx + 1);
  }

  if (occurrences.length === 0) {
    return { error: `未找到匹配的文本: "${input.old_string.slice(0, 80)}"` };
  }

  if (occurrences.length > 1) {
    return {
      error:
        `找到 ${occurrences.length} 处匹配，请提供更完整的上下文使匹配唯一，` +
        `或设置 replace_all: true 替换所有出现`,
    };
  }

  const newContent =
    content.slice(0, occurrences[0]) +
    input.new_string +
    content.slice(occurrences[0] + input.old_string.length);
  await fs.writeFile(resolved, newContent, "utf-8");
  return {
    path: input.filePath,
    replacements: 1,
    status: "ok",
  };
}

export const editFileConfig = {
  name: "edit_file",
  description:
    "在文件中精确替换文本。old_string 必须与文件中要替换的部分完全一致（唯一匹配），" +
    "或使用 replace_all 标志替换所有出现。",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "要编辑的文件路径（相对于工作目录）" },
      old_string: { type: "string", description: "要被替换的原文本，必须精确匹配" },
      new_string: { type: "string", description: "替换后的新文本" },
      replace_all: { type: "boolean", description: "是否替换所有出现。默认 false" },
    },
    required: ["filePath", "old_string", "new_string"],
  },
  execute: (input: any) =>
    executeEditFile(
      input as { filePath: string; old_string: string; new_string: string; replace_all?: boolean },
    ),
  isReadOnly: false,
  isConcurrencySafe: false,
  maxResultChars: 300,
  schema: editFileTool,
} satisfies ToolDefinition & { schema: unknown };
