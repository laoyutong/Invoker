import type { PromptModule } from "../types";

/**
 * 告知模型还有哪些延迟工具可供激活。
 * deferredToolSummary 为空时跳过。
 */
export const deferredTools = (): PromptModule =>
  (ctx) => {
    if (!ctx.deferredToolSummary) return null;

    return `## 可激活工具
以下工具尚未激活，当你需要使用时，请在回复中提及工具名称或相关关键词，系统会自动激活它们：

${ctx.deferredToolSummary}

注意：不要直接调用未激活的工具，先引导用户触发激活。`;
  };
