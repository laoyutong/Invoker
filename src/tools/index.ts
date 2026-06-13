import type { Tool } from "ai";

export interface ToolDefinition {
  name: string;
  description: string; // 给模型看的描述
  parameters: Record<string, unknown>; // JSON Schema
  execute: (input: unknown) => Promise<unknown>;

  // 元数据——给 Agent Loop 做决策用
  isConcurrencySafe?: boolean; // 能否并行
  isReadOnly?: boolean; // 是否只读
  maxResultChars?: number; // 结果最大长度

  // 延迟加载——工具按需注册到模型
  shouldDefer?: boolean; // 是否延迟注册（不会在启动时注入 system prompt）
  searchHint?: string; // 搜索提示词，用于匹配用户意图后动态加载
}

type ToolEntry = ToolDefinition & { schema: Tool };

export class ToolRegistry {
  private tools = new Map<string, ToolEntry>();
  private activated = new Set<string>();

  /** 注册工具。shouldDefer 为 false 或未设置时自动激活 */
  register(tool: ToolEntry): void {
    if (this.tools.has(tool.name)) {
      console.warn(`⚠️ 工具 "${tool.name}" 已存在，将被覆盖`);
    }
    this.tools.set(tool.name, tool);

    if (!tool.shouldDefer) {
      this.activated.add(tool.name);
    }
  }

  /** 按名称查找工具 */
  lookup(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }

  /** 激活一个已注册但延迟加载的工具 */
  activate(name: string): boolean {
    if (!this.tools.has(name)) return false;
    this.activated.add(name);
    return true;
  }

  /** 检查工具是否已激活（对模型可见） */
  isActivated(name: string): boolean {
    return this.activated.has(name);
  }

  /** 获取所有延迟加载（尚未激活）的工具名称 */
  deferredNames(): string[] {
    return [...this.tools.keys()].filter((n) => !this.activated.has(n));
  }

  /** 转换为 AI SDK streamText 所需的 tools 格式，仅返回已激活的工具 */
  toAISDKFormat(): Record<string, Tool> {
    const result: Record<string, Tool> = {};
    for (const [name, entry] of this.tools) {
      if (this.activated.has(name)) {
        result[name] = entry.schema;
      }
    }
    return result;
  }

  /** 获取所有工具名称 */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** 获取所有已激活的工具名称 */
  activeNames(): string[] {
    return [...this.activated];
  }
}

// 全局单例
export const toolRegistry = new ToolRegistry();
