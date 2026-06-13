import type { ModelMessage } from "ai";

import { CONTEXT_CLEANUP, CONTEXT_WINDOW, TOOL_RESULT_BUDGET, TOOL_RESULT_TTL } from "./constants";
import { isToolCallPart, isToolResultPart } from "./message-parts";
import { toolRegistry } from "./tools";

const ERROR_KEYWORDS = [
  "error",
  "Error",
  "ERROR",
  "fail",
  "Fail",
  "FAIL",
  "failed",
  "Failed",
  "failure",
  "Failure",
  "not found",
  "Not found",
  "Not Found",
  "NOT FOUND",
  "not exist",
  "Not exist",
  "does not exist",
  "no such file",
  "No such file",
  "异常",
  "错误",
  "失败",
  "不存在",
  "未找到",
  "ENOENT",
  "EACCES",
  "EPERM",
  "ECONNREFUSED",
  "ETIMEDOUT",
];

const hasErrorKeyword = (text: string): boolean => ERROR_KEYWORDS.some((kw) => text.includes(kw));

const pruneExpiredToolResults = (
  messages: ModelMessage[],
  toolResultTimestamps: Map<string, number>,
): void => {
  const now = Date.now();
  const hardClearedIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;

    const firstPart = msg.content[0];
    if (!isToolResultPart(firstPart) || typeof firstPart.toolName !== "string") continue;
    const def = toolRegistry.lookup(firstPart.toolName);
    if (!def?.isReadOnly) continue;

    msg.content = msg.content.map((part: unknown) => {
      if (!isToolResultPart(part) || typeof part.toolCallId !== "string") return part;

      const timestamp = toolResultTimestamps.get(part.toolCallId);
      if (timestamp === undefined) return part;

      const age = now - timestamp;
      const value = part.output?.value;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (age >= TOOL_RESULT_TTL.softPruneMs && hasErrorKeyword(text)) {
        return part;
      }

      if (age >= TOOL_RESULT_TTL.hardClearMs) {
        hardClearedIds.add(part.toolCallId);
        return {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: {
            type: "json",
            value: `[tool result expired: ${String(part.toolName)}]`,
          },
        };
      }

      if (age >= TOOL_RESULT_TTL.softPruneMs) {
        if (text.includes("[soft pruned]")) return part;

        const headLen = TOOL_RESULT_TTL.softPruneHeadChars;
        const tailLen = TOOL_RESULT_TTL.softPruneTailChars;

        if (text.length > headLen + tailLen + 100) {
          const head = text.slice(0, headLen);
          const tail = text.slice(-tailLen);
          const skipped = text.length - headLen - tailLen;
          return {
            ...part,
            output: {
              type: "json",
              value: `${head}\n\n...[soft pruned: ${skipped} chars]...\n\n${tail}`,
            },
          };
        }
      }

      return part;
    }) as typeof msg.content;
  }

  if (hardClearedIds.size > 0) {
    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      msg.content = msg.content.filter((part: unknown) => {
        if (isToolCallPart(part) && typeof part.toolCallId === "string") {
          return !hardClearedIds.has(part.toolCallId);
        }
        return true;
      });
    }
    console.log(`\n⏰ TTL 硬清除: ${hardClearedIds.size} 条工具结果已过期`);
  }
};

const enforceToolResultBudget = (messages: ModelMessage[]): Set<string> => {
  const maxTotalChars = Math.floor(
    CONTEXT_WINDOW.maxTokens * 4 * TOOL_RESULT_BUDGET.maxTotalResultsRatio,
  );

  const entries: Array<{
    index: number;
    toolCallId: string;
    toolName: string;
    chars: number;
  }> = [];
  let totalChars = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        isToolResultPart(part) &&
        typeof part.toolCallId === "string" &&
        typeof part.toolName === "string"
      ) {
        const chars = JSON.stringify(part).length;
        entries.push({
          index: i,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          chars,
        });
        totalChars += chars;
      }
    }
  }

  if (totalChars <= maxTotalChars) return new Set();

  console.log(
    `\n📏 工具结果总量 ${(totalChars / 1024).toFixed(0)}KB 超出窗口 75%（${(maxTotalChars / 1024).toFixed(0)}KB），从最老的结果开始清理`,
  );

  const clearedIds = new Set<string>();
  let excess = totalChars - maxTotalChars;

  for (const { index, toolCallId, toolName, chars } of entries) {
    if (excess <= 0) break;

    const msg = messages[index];
    if (!Array.isArray(msg.content)) continue;

    msg.content = msg.content.map((part: unknown) => {
      if (isToolResultPart(part) && part.toolCallId === toolCallId) {
        return {
          type: "tool-result",
          toolCallId,
          toolName,
          output: {
            type: "json",
            value: "[tool result truncated: context budget exceeded]",
          },
        };
      }
      return part;
    }) as typeof msg.content;

    clearedIds.add(toolCallId);
    excess -= chars;
  }

  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    msg.content = msg.content.filter((part: unknown) => {
      if (isToolCallPart(part) && typeof part.toolCallId === "string") {
        return !clearedIds.has(part.toolCallId);
      }
      return true;
    });
  }

  console.log(`   ✅ 已清理 ${clearedIds.size} 条工具结果`);
  return clearedIds;
};

const cleanOldReadOnlyToolResults = (messages: ModelMessage[]): void => {
  const keepCount = CONTEXT_CLEANUP.keepRecentReadOnlyResults;

  const entries: Array<{ index: number; toolCallId: string; toolName: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;
    if (!Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (isToolResultPart(part) && typeof part.toolName === "string") {
        const def = toolRegistry.lookup(part.toolName);
        if (def?.isReadOnly) {
          entries.push({
            index: i,
            toolCallId: String(part.toolCallId),
            toolName: part.toolName,
          });
        }
      }
    }
  }

  if (entries.length <= CONTEXT_CLEANUP.cleanupThreshold) return;

  const toClear = entries.slice(0, entries.length - keepCount);
  const clearedIds = new Set(toClear.map((e) => e.toolCallId));

  for (const { index, toolCallId, toolName } of toClear) {
    const msg = messages[index];
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.map((part: unknown) => {
      if (isToolResultPart(part) && part.toolCallId === toolCallId) {
        return {
          type: "tool-result",
          toolCallId,
          toolName,
          output: { type: "json", value: "[tool result cleared]" },
        };
      }
      return part;
    }) as typeof msg.content;
  }

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.filter((part: unknown) => {
      if (isToolCallPart(part) && typeof part.toolCallId === "string") {
        return !clearedIds.has(part.toolCallId);
      }
      return true;
    });
  }
};

export const cleanupToolResults = (
  messages: ModelMessage[],
  toolResultTimestamps: Map<string, number>,
): void => {
  enforceToolResultBudget(messages);
  pruneExpiredToolResults(messages, toolResultTimestamps);
  cleanOldReadOnlyToolResults(messages);
};
