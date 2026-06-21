/** 运行时上下文，每个 prompt 模块按需读取 */
export interface PromptContext {
  toolCount: number;
  deferredToolSummary: string;
  longTermMemory: string;
  sessionMessageCount: number;
  sessionId: string;
}

/** prompt 模块：接收上下文，返回要注入的 prompt 片段；返回 null 表示跳过 */
export type PromptModule = (ctx: PromptContext) => string | null;
