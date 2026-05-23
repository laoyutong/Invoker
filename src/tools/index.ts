import type { Tool } from "ai";

export interface ToolDefinition {
  name: string;
  description: string; // 给模型看的描述
  parameters: Record<string, unknown>; // JSON Schema
  execute: (input: any) => Promise<unknown>;

  // 元数据——给 Agent Loop 做决策用
  isConcurrencySafe?: boolean; // 能否并行
  isReadOnly?: boolean; // 是否只读
  maxResultChars?: number; // 结果最大长度
}

type ToolEntry = ToolDefinition & { schema: Tool };

export class ToolRegistry {
  private tools = new Map<string, ToolEntry>();

  /** 注册工具 */
  register(tool: ToolEntry): void {
    if (this.tools.has(tool.name)) {
      console.warn(`⚠️ 工具 "${tool.name}" 已存在，将被覆盖`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 按名称查找工具 */
  lookup(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }

  /** 转换为 AI SDK streamText 所需的 tools 格式 */
  toAISDKFormat(): Record<string, Tool> {
    const result: Record<string, Tool> = {};
    for (const [name, entry] of this.tools) {
      result[name] = entry.schema;
    }
    return result;
  }

  /** 获取所有工具名称 */
  names(): string[] {
    return [...this.tools.keys()];
  }
}

// 全局单例
export const toolRegistry = new ToolRegistry();
