import type { PromptModule } from "../types";

/**
 * 注入跨会话长期记忆。
 * 记忆只保存对话独有信息；若与当前事实冲突，模型应以当前事实为准。
 */
export const memory = (): PromptModule => (ctx) => {
  if (!ctx.longTermMemory) return null;
  return ctx.longTermMemory;
};
