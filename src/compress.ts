import { generateText, type ModelMessage } from "ai";

import { CONTEXT_COMPRESSION } from "./constants";
import { model } from "./model";
import type { TokenTracker } from "./token-tracker";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * 压缩提示词 —— 严格结构化模板
 *
 * 模型必须按此模板输出摘要，不能添加任何额外内容。
 */
const COMPRESSION_PROMPT = `你是一个对话压缩系统。请将以下早期对话压缩为结构化摘要。

严格遵循模板，只输出摘要本身，不要加任何前缀、后缀或解释性文字。

如果对话开头已经包含 [历史对话摘要]，说明这是增量压缩——请将旧摘要中的信息与新对话合并，生成一份完整的新摘要，不得丢失旧摘要中的关键信息。

## 摘要模板

### 用户意图
[一句话描述用户的核心目标，例如"修复登录页面的 CSRF 漏洞"、"为 API 添加分页支持"]

### 工作计划
[已制定的工作步骤或执行计划，用 - 列出；如果没有明确计划则填"无"]

### 关键发现
[重要的发现：文件路径、代码模式、API 用法、错误原因等；每条单独一行用 - 列出；没有则填"无"]

### 已做决策
[架构决策、技术选型、明确拒绝的方案及原因；每条单独一行用 - 列出；没有则填"无"]

### 当前状态
[已完成什么、进行中什么、还有什么待完成]

### 关键上下文
[必须保留的具体信息：完整文件路径、错误堆栈、配置参数、版本号、数据库连接信息等。宁可多保留，不可遗漏]

---

以下是需要压缩的早期对话：`;

/**
 * 将 ModelMessage[] 格式化为 LLM 可读的纯文本
 */
const formatMessages = (msgs: ModelMessage[]): string => {
  const lines: string[] = [];

  for (const msg of msgs) {
    switch (msg.role) {
      case "user": {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        lines.push(`[用户]: ${text}`);
        break;
      }

      case "assistant": {
        if (typeof msg.content === "string") {
          lines.push(`[助手]: ${msg.content}`);
        } else if (Array.isArray(msg.content)) {
          const parts: string[] = ["[助手]:"];
          for (const part of msg.content as unknown[]) {
            if (!isRecord(part)) continue;
            if (part.type === "text" && typeof part.text === "string") {
              parts.push(`  ${part.text}`);
            } else if (part.type === "reasoning" && typeof part.text === "string") {
              parts.push(`  [思考: ${part.text.slice(0, 300)}]`);
            } else if (part.type === "tool-call") {
              parts.push(
                `  [调用工具 ${part.toolName}: ${JSON.stringify(part.input).slice(0, 500)}]`,
              );
            }
          }
          lines.push(parts.join("\n"));
        }
        break;
      }

      case "tool": {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content as unknown[]) {
            if (isRecord(part) && part.type === "tool-result") {
              const output = isRecord(part.output) ? part.output.value : undefined;
              const outputStr = typeof output === "string" ? output : JSON.stringify(output);
              const truncated =
                outputStr.length > 2000 ? `${outputStr.slice(0, 2000)}...[截断]` : outputStr;
              lines.push(`[工具结果 ${part.toolName}]: ${truncated}`);
            }
          }
        }
        break;
      }
    }
  }

  return lines.join("\n\n");
};

/**
 * 压缩早期对话，用 LLM 生成结构化摘要替换旧消息。
 *
 * - 仅在消息总数超过 messageThreshold 时触发
 * - 保留最近 keepRecent 条消息不动
 * - 将更早的消息压缩为一条用户消息插入到保留区之前
 * - 压缩失败不阻塞正常流程
 */
export const compressConversation = async (
  messages: ModelMessage[],
  tokenTracker?: TokenTracker,
): Promise<void> => {
  const { messageThreshold, keepRecent, minCompressCount } = CONTEXT_COMPRESSION;

  if (messages.length <= messageThreshold) return;

  let compressCount = messages.length - keepRecent;
  if (compressCount < minCompressCount) return;

  // 对齐消息边界：切分点必须在 user 消息上，避免割裂 assistant(tool-call) + tool(result) 配对
  while (compressCount > 0 && messages[compressCount]?.role !== "user") {
    compressCount--;
  }

  if (compressCount < minCompressCount) return;

  const toCompress = messages.slice(0, compressCount);

  console.log(
    `\n📦 上下文过长（${messages.length} 条），调用 LLM 压缩早期 ${toCompress.length} 条消息...`,
  );

  const formattedMessages = formatMessages(toCompress);
  const prompt = `${COMPRESSION_PROMPT}\n\n${formattedMessages}`;

  try {
    const { text } = await generateText({
      model,
      prompt,
      maxRetries: 0,
    });

    const trimmed = text.trim();
    if (!trimmed) {
      console.log("⚠️ LLM 返回空摘要，跳过压缩");
      return;
    }

    const summary = `[历史对话摘要 —— 以下是你与用户之前对话的结构化总结]\n\n${trimmed}`;
    messages.splice(0, compressCount, {
      role: "user",
      content: summary,
    } as ModelMessage);

    // 替换后 net 变化用 chars/4 粗估（下次 API 调用会校准）
    tokenTracker?.addEstimate(summary.length);

    console.log(
      `✅ 压缩完成：${toCompress.length} 条早期消息 → 1 条摘要（当前共 ${messages.length} 条消息）`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`⚠️ LLM 压缩失败，保留原始消息: ${reason}`);
  }
};
