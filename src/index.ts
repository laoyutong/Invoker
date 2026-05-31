import * as readline from "node:readline";
import { type LanguageModelUsage, type ModelMessage, streamText } from "ai";

import "./model";
import { compressConversation } from "./compress";
import { CONTEXT_CLEANUP, CONTEXT_WINDOW, MAX_TOOL_LOOPS, TOOL_RESULT_BUDGET, TOOL_RESULT_TTL } from "./constants";
import { CycleDetector } from "./cycle-detector";
import { initMCP } from "./mcp";
import { MODEL_NAME, model } from "./model";
import { buildPrompt } from "./prompt";
import { withRetry } from "./retry";
import { getSessionId, initSession, loadSession, saveSession, sessionExists } from "./session";
import { TokenTracker } from "./token-tracker";
import { type ToolDefinition, toolRegistry } from "./tools";
import { bashConfig } from "./tools/bash";
import { editFileConfig } from "./tools/edit-file";
import { fetchUrlConfig } from "./tools/fetch-url";
import { findFilesConfig } from "./tools/find-files";
import { globConfig } from "./tools/glob";
import { grepConfig } from "./tools/grep";
import { readFileConfig } from "./tools/read-file";
import { activateByKeywords } from "./tools/search";
import { writeFileConfig } from "./tools/write-file";

for (const cfg of [
  readFileConfig,
  writeFileConfig,
  findFilesConfig,
  editFileConfig,
  fetchUrlConfig,
  globConfig,
  grepConfig,
  bashConfig,
]) {
  toolRegistry.register(cfg);
}

type ToolCallEntry = { toolCallId: string; toolName: string; input: unknown };

type AssistantContentPart =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };

const args = process.argv.slice(2);

const parseArgs = (argv: string[]): { shouldContinue: boolean; targetSessionId?: string } => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--continue" || argv[i] === "-c") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        return { shouldContinue: true, targetSessionId: next };
      }
      return { shouldContinue: true };
    }
  }
  return { shouldContinue: false };
};

const { shouldContinue, targetSessionId } = parseArgs(args);

let messages: ModelMessage[] = [];
/** 工具结果的时间戳记录，用于 TTL 修剪（toolCallId → 创建时间） */
const toolResultTimestamps = new Map<string, number>();
const cycleDetector = new CycleDetector();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const STOP_WORDS = new Set([
  "的",
  "了",
  "在",
  "是",
  "我",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "一个",
  "上",
  "也",
  "很",
  "到",
  "说",
  "要",
  "去",
  "你",
  "会",
  "着",
  "没有",
  "看",
  "好",
  "自己",
  "这",
  "他",
  "她",
  "它",
  "们",
  "那",
  "些",
  "什么",
  "怎么",
  "如何",
  "可以",
  "能",
  "请",
  "帮",
  "让",
  "用",
  "把",
  "给",
  "a",
  "an",
  "the",
  "is",
  "of",
  "to",
  "in",
  "for",
  "and",
  "or",
  "with",
  "be",
  "it",
  "on",
  "at",
  "by",
  "from",
  "this",
  "that",
  "what",
  "which",
]);

/**
 * 从用户输入中提取关键词，用于匹配延迟加载的工具
 */
const extractKeywords = (input: string): string[] => {
  // 从中文混合文本中提取有意义的 token：
  // 1. 按标点/空格切分
  const byDelimiter = input.split(/[\s,，。！？、；：""''（）()[\]{}<>《》.!?;:]+/);
  // 2. 提取英文/数字连续序列（github、issue、PR 等）
  const alphaNumeric = input.match(/[a-zA-Z0-9_]+/g) ?? [];
  const tokens = [...byDelimiter, ...alphaNumeric]
    .filter((t) => t.length >= 2)
    .filter((t) => !STOP_WORDS.has(t.toLowerCase()));
  return [...new Set(tokens)];
}

const ask = (): Promise<string> => {
  return new Promise((resolve) => {
    rl.question("> ", (answer) => {
      resolve(answer);
    });
  });
};

const logToolCall = (name: string, input: unknown) => {
  console.log(`\n📦 模型调用工具: ${name}`);
  console.log(`   └─ 入参: ${JSON.stringify(input)}`);
};

const truncateResult = (
  output: unknown,
  maxChars: number,
): { truncated: boolean; text: string; skipped: number } => {
  const text = JSON.stringify(output);
  if (text.length <= maxChars) {
    return { truncated: false, text, skipped: 0 };
  }

  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = maxChars - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  const skipped = text.length - maxChars;

  return {
    truncated: true,
    text: `${head}…[省略 ${skipped} 字符]…${tail}`,
    skipped,
  };
};

const logToolResult = (_name: string, output: unknown, maxChars?: number) => {
  if (!maxChars) {
    console.log(`   └─ 结果: ${JSON.stringify(output)}`);
    return;
  }
  const { text } = truncateResult(output, maxChars);
  console.log(`   └─ 结果: ${text}`);
};

const ERROR_KEYWORDS = [
  "error", "Error", "ERROR",
  "fail", "Fail", "FAIL",
  "failed", "Failed",
  "failure", "Failure",
  "not found", "Not found", "Not Found", "NOT FOUND",
  "not exist", "Not exist", "does not exist",
  "no such file", "No such file",
  "异常", "错误", "失败", "不存在", "未找到",
  "ENOENT", "EACCES", "EPERM", "ECONNREFUSED", "ETIMEDOUT",
];

const hasErrorKeyword = (text: string): boolean =>
  ERROR_KEYWORDS.some((kw) => text.includes(kw));

/**
 * TTL 修剪：按时间清理只读工具结果。
 * - 包含错误/失败关键词的结果跳过，不修剪
 * - 软修剪（> 5 分钟）：保留头尾各 1500 字符，中间替换为 [soft pruned]
 * - 硬清除（> 10 分钟）：整个结果替换为 [tool result expired: tool_name]，移除对应 tool-call
 */
const pruneExpiredToolResults = (messages: ModelMessage[]): void => {
  const now = Date.now();
  const hardClearedIds = new Set<string>();
  let skippedErrors = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;

    // 检查是否为只读工具
    const firstPart = msg.content[0] as any;
    if (firstPart?.type !== "tool-result" || !firstPart.toolName) continue;
    const def = toolRegistry.lookup(firstPart.toolName as string);
    if (!def?.isReadOnly) continue;

    msg.content = msg.content.map((part: any) => {
      if (part.type !== "tool-result" || !part.toolCallId) return part;

      const timestamp = toolResultTimestamps.get(part.toolCallId as string);
      if (timestamp === undefined) return part; // session 恢复的老结果，无时间戳，跳过

      const age = now - timestamp;

      // 检查是否包含错误/失败关键词，命中则跳过不修剪
      const value = part.output?.value;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (age >= TOOL_RESULT_TTL.softPruneMs && hasErrorKeyword(text)) {
        skippedErrors++;
        return part;
      }

      // 硬清除：整个结果替换为占位符
      if (age >= TOOL_RESULT_TTL.hardClearMs) {
        hardClearedIds.add(part.toolCallId as string);
        return {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: {
            type: "json",
            value: `[tool result expired: ${part.toolName}]`,
          },
        };
      }

      // 软修剪：保留头尾，中间替换
      if (age >= TOOL_RESULT_TTL.softPruneMs) {
        // 已软修剪过的跳过（避免嵌套标记）
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
    });
  }

  // 移除硬清除结果对应的 assistant tool-call
  if (hardClearedIds.size > 0) {
    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      msg.content = (msg.content as any[]).filter((part: any) => {
        if (part.type === "tool-call" && "toolCallId" in part) {
          return !hardClearedIds.has(part.toolCallId as string);
        }
        return true;
      });
    }
    console.log(
      `\n⏰ TTL 硬清除: ${hardClearedIds.size} 条工具结果已过期`,
    );
  }
};

/**
 * 总量预算：所有工具结果的字符总和不能超过上下文窗口的 75%。
 * 超限时从最老的 tool result 开始替换为占位符，同时移除对应的 assistant tool-call。
 * 返回被清理的 toolCallId 集合，供上层知晓哪些工具结果被截断。
 */
const enforceToolResultBudget = (messages: ModelMessage[]): Set<string> => {
  const maxTotalChars = Math.floor(
    CONTEXT_WINDOW.maxTokens * 4 * TOOL_RESULT_BUDGET.maxTotalResultsRatio,
  );

  // 收集所有 tool 消息及其字符数
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
      if (part.type === "tool-result" && "toolCallId" in part) {
        const chars = JSON.stringify(part).length;
        entries.push({
          index: i,
          toolCallId: part.toolCallId as string,
          toolName: (part as any).toolName as string,
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

  // 从最老到最新逐个清理，直到总量回归预算内
  const clearedIds = new Set<string>();
  let excess = totalChars - maxTotalChars;

  for (const { index, toolCallId, toolName, chars } of entries) {
    if (excess <= 0) break;

    const msg = messages[index];
    if (!Array.isArray(msg.content)) continue;

    msg.content = msg.content.map((part: any) => {
      if (part.type === "tool-result" && part.toolCallId === toolCallId) {
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
    });

    clearedIds.add(toolCallId);
    excess -= chars;
  }

  // 移除对应的 assistant tool-call
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    msg.content = (msg.content as any[]).filter((part: any) => {
      if (part.type === "tool-call" && "toolCallId" in part) {
        return !clearedIds.has(part.toolCallId as string);
      }
      return true;
    });
  }

  console.log(`   ✅ 已清理 ${clearedIds.size} 条工具结果`);
  return clearedIds;
};

/**
 * 清理旧的只读（查询类）工具结果，保留最近 N 个不动。
 * 被清理的结果替换为 [tool result cleared]，同时移除 assistant 消息中对应的 tool-call。
 */
const cleanOldReadOnlyToolResults = (messages: ModelMessage[]): void => {
  const keepCount = CONTEXT_CLEANUP.keepRecentReadOnlyResults;

  // Step 1: 从旧到新扫描所有只读工具结果，记录位置
  const entries: Array<{ index: number; toolCallId: string; toolName: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;
    if (!Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (part.type === "tool-result" && "toolName" in part) {
        const def = toolRegistry.lookup(part.toolName as string);
        if (def?.isReadOnly) {
          entries.push({
            index: i,
            toolCallId: part.toolCallId as string,
            toolName: part.toolName as string,
          });
        }
      }
    }
  }

  // 未达到清理阈值，跳过
  if (entries.length <= CONTEXT_CLEANUP.cleanupThreshold) return;

  // Step 2: 标记需要清理的（保留最后 keepCount 个）
  const toClear = entries.slice(0, entries.length - keepCount);
  const clearedIds = new Set(toClear.map((e) => e.toolCallId));

  // Step 3: 替换 tool 消息的结果内容
  for (const { index, toolCallId, toolName } of toClear) {
    const msg = messages[index];
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.map((part: any) => {
      if (part.type === "tool-result" && part.toolCallId === toolCallId) {
        return {
          type: "tool-result",
          toolCallId,
          toolName,
          output: { type: "json", value: "[tool result cleared]" },
        };
      }
      return part;
    });
  }

  // Step 4: 从 assistant 消息中移除已清理的 tool-call 部分
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    msg.content = (msg.content as any[]).filter((part: any) => {
      if (part.type === "tool-call" && "toolCallId" in part) {
        return !clearedIds.has(part.toolCallId as string);
      }
      return true;
    });
  }
};

const RECENT_COUNT = 6;

const renderContent = (content: unknown, maxLen = 200): string => {
  if (typeof content === "string") return content.slice(0, maxLen);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        switch (part.type) {
          case "text":
            return (part.text as string).slice(0, maxLen);
          case "reasoning":
            return `[思考] ${(part.text as string).slice(0, 100)}`;
          case "tool-call":
            return `[调用 ${part.toolName}]`;
          case "tool-result":
            return `[工具结果]`;
          default:
            return "";
        }
      })
      .filter(Boolean)
      .join(" ");
  }
  return String(content).slice(0, maxLen);
}

const renderRecentMessages = (messages: ModelMessage[]): void => {
  const recent = messages.slice(-RECENT_COUNT);
  if (recent.length === 0) return;

  const label: Record<string, string> = {
    user: "👤",
    assistant: "🤖",
    tool: "🔧",
  };

  console.log(`\n── 最近 ${recent.length} 条消息 ──`);
  for (const msg of recent) {
    const role = msg.role;
    const prefix = label[role] ?? role;
    const text = renderContent(msg.content);
    if (text) {
      console.log(`  ${prefix}  ${text}`);
    }
  }
  console.log("──────────\n");
}

/** 初始化或恢复 session，加载历史消息 */
const initOrRestoreSession = (): void => {
  if (shouldContinue) {
    if (sessionExists()) {
      messages = loadSession();
      console.log(`📂 恢复 session ${getSessionId()}，${messages.length} 条历史消息`);
      renderRecentMessages(messages);
      return;
    }
    console.log(`⚠️  未找到 session 文件，开始新会话 ${getSessionId()}`);
  } else {
    console.log(`📋 新会话 ${getSessionId()}`);
  }
}

/** 组装当前运行时上下文并构建 system prompt */
const buildSystemPrompt = (): string => {
  const deferredNames = toolRegistry.deferredNames();
  const deferredToolSummary = deferredNames
    .map((name) => {
      const t = toolRegistry.lookup(name);
      const hint = t?.searchHint ? `（关键词: ${t.searchHint}）` : "";
      return `- ${name}: ${t?.description ?? ""}${hint}`;
    })
    .join("\n");

  return buildPrompt({
    toolCount: toolRegistry.activeNames().length,
    deferredToolSummary,
    sessionMessageCount: messages.length,
    sessionId: getSessionId(),
  });
}

/** 用用户输入的关键词激活匹配的延迟工具 */
const activateDeferredTools = (input: string): void => {
  const keywords = extractKeywords(input);
  const activatedSet = new Set<string>();
  const activatedNames: string[] = [];
  for (const kw of keywords) {
    for (const t of activateByKeywords([kw])) {
      if (!activatedSet.has(t.name)) {
        activatedSet.add(t.name);
        activatedNames.push(t.name);
      }
    }
  }
  if (activatedNames.length > 0) {
    console.log(`🔓 激活延迟工具: ${activatedNames.join(", ")}`);
  }
}

const main = async () => {
  await initMCP();

  initSession({ continueSession: shouldContinue, targetId: targetSessionId });
  initOrRestoreSession();

  console.log('输入对话内容，"exit" 退出，"/usage" 用量，"/context" 上下文\n');

  const tokenTracker = new TokenTracker(MODEL_NAME);

  /** 推送消息到上下文，同时用 chars/4 粗估 token 增量 */
  const pushMessage = (msg: ModelMessage): void => {
    messages.push(msg);
    const text =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    tokenTracker.addEstimate(text.length);

    // 记录工具结果时间戳，用于 TTL 修剪
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          part.type === "tool-result" &&
          "toolCallId" in part &&
          typeof (part as any).toolCallId === "string"
        ) {
          toolResultTimestamps.set((part as any).toolCallId as string, Date.now());
        }
      }
    }
  };

  while (true) {
    const input = await ask();

    if (input.toLowerCase() === "exit") {
      console.log(`再见！Session: ${getSessionId()}`);
      break;
    }

    if (input.trim() === "/usage") {
      console.log(tokenTracker.summary());
      continue;
    }

    if (input.trim() === "/context") {
      console.log(tokenTracker.context());
      continue;
    }

    if (!input.trim()) continue;

    pushMessage({ role: "user", content: input });

    activateDeferredTools(input);

    let loopCount = 0;
    let keepCalling = true;
    cycleDetector.reset();

    try {
      while (keepCalling) {
        if (loopCount >= MAX_TOOL_LOOPS) {
          console.log(`\n⚠️ 工具调用已达上限 ${MAX_TOOL_LOOPS} 次，强制终止`);
          pushMessage({
            role: "assistant",
            content: "工具调用次数过多，已终止。",
          } as ModelMessage);
          break;
        }
        loopCount++;

        const { fullText, reasoningText, toolCalls, streamUsage } = await withRetry(async () => {
          const systemPrompt = buildSystemPrompt();
          const tools = toolRegistry.toAISDKFormat();

          // 更新静态上下文，供 /context 命令展示（tracker 内部做 chars→token 粗估 + API 校准）
          tokenTracker.updateStaticContext(systemPrompt.length, JSON.stringify(tools).length);

          const { fullStream } = streamText({
            model,
            system: systemPrompt,
            messages,
            tools,
            maxRetries: 0, // 禁用 SDK 内置重试，走自定义指数退避
            onError: () => {}, // 屏蔽 SDK 默认的 console.error 输出
          });

          let fullText = "";
          let reasoningText = "";
          let streamError: unknown = null;
          let streamUsage: LanguageModelUsage | null = null;
          const toolCalls: ToolCallEntry[] = [];

          for await (const part of fullStream) {
            switch (part.type) {
              case "text-delta":
                process.stdout.write(part.text);
                fullText += part.text;
                break;

              case "reasoning-delta":
                reasoningText += part.text;
                break;

              case "error":
                streamError = part.error;
                break;

              case "tool-call":
                logToolCall(part.toolName, part.input);
                toolCalls.push({
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                });
                break;

              case "finish-step":
                streamUsage = part.usage;
                break;

              case "finish":
                // finish.totalUsage 是单步调用的汇总，优先使用
                streamUsage = part.totalUsage;
                break;
            }
          }

          // 流式错误不会自动抛出，需要手动检测后抛给 withRetry 处理
          if (streamError) throw streamError;

          return { fullText, reasoningText, toolCalls, streamUsage };
        });

        // 累计 token 用量 + 预算追踪
        if (streamUsage) {
          tokenTracker.track(streamUsage);

          if (tokenTracker.isExhausted()) {
            console.log("🛑 本轮 Token 预算已耗尽\n");
            process.stdout.write("\n\n");
            pushMessage({
              role: "assistant",
              content: fullText || "已达到 Token 预算上限。",
            } as ModelMessage);
            keepCalling = false;
            continue;
          }
        }

        if (toolCalls.length === 0) {
          process.stdout.write("\n\n");
          pushMessage({ role: "assistant", content: fullText });
          keepCalling = false;
        } else {
          console.log(`\n🔧 执行工具中...`);

          // 保存循环检测所需的"输入"消息（assistant 看到的上一条消息）
          const lastInputMsg = messages[messages.length - 1];

          // 推送 assistant 消息
          const contentParts: AssistantContentPart[] = [];
          if (reasoningText) contentParts.push({ type: "reasoning", text: reasoningText });
          if (fullText) contentParts.push({ type: "text", text: fullText });
          for (const tc of toolCalls) {
            contentParts.push({ type: "tool-call", ...tc });
          }
          pushMessage({ role: "assistant", content: contentParts } as ModelMessage);

          // 执行工具并推送结果
          // 按 isConcurrencySafe 分组：不安全工具前后形成"栅栏"，安全工具相邻可并行
          const entries: { tc: ToolCallEntry; entry: ToolDefinition }[] = [];
          for (const tc of toolCalls) {
            const entry = toolRegistry.lookup(tc.toolName);
            if (entry) entries.push({ tc, entry });
          }

          const executeOne = async (tc: ToolCallEntry, entry: ToolDefinition) => {
            const rawResult = await entry.execute(tc.input);

            // 动态截断上限：单条结果 ≤ 上下文窗口 50%（取 tool 自身限制与动态上限的较小值）
            const maxSingleChars = Math.floor(
              CONTEXT_WINDOW.maxTokens * 4 * TOOL_RESULT_BUDGET.maxSingleResultRatio,
            );
            const effectiveMaxChars = entry.maxResultChars
              ? Math.min(entry.maxResultChars, maxSingleChars)
              : maxSingleChars;

            let result: unknown = rawResult;
            if (JSON.stringify(rawResult).length > effectiveMaxChars) {
              const { truncated, text, skipped } = truncateResult(rawResult, effectiveMaxChars);
              if (truncated) {
                result = { _truncated: true, _skipped: skipped, content: text };
              }
            }
            return { tc, result, rawResult, entry };
          };

          // 以不安全工具为边界切分 group
          const groups: { tc: ToolCallEntry; entry: ToolDefinition }[][] = [];
          let current: (typeof groups)[0] = [];
          for (const e of entries) {
            if (e.entry.isConcurrencySafe) {
              current.push(e);
            } else {
              if (current.length > 0) {
                groups.push(current);
                current = [];
              }
              groups.push([e]); // 不安全工具独占一组
            }
          }
          if (current.length > 0) groups.push(current);

          // 组间串行，组内安全工具并行
          for (const group of groups) {
            if (group.length === 1 && !group[0].entry.isConcurrencySafe) {
              // 不安全工具：独占执行
              const { tc, entry } = group[0];
              const { result, rawResult } = await executeOne(tc, entry);
              logToolResult(tc.toolName, rawResult, entry.maxResultChars);
              pushMessage({
                role: "tool",
                content: [
                  {
                    type: "tool-result" as const,
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    output: { type: "json" as const, value: result },
                  },
                ],
              } as ModelMessage);
            } else {
              // 安全工具组：并行执行（Promise.all 保证结果顺序与调用顺序一致）
              const results = await Promise.all(group.map((e) => executeOne(e.tc, e.entry)));
              for (const { tc, rawResult, entry } of results) {
                logToolResult(tc.toolName, rawResult, entry.maxResultChars);
              }
              for (const { tc, result } of results) {
                pushMessage({
                  role: "tool",
                  content: [
                    {
                      type: "tool-result" as const,
                      toolCallId: tc.toolCallId,
                      toolName: tc.toolName,
                      output: { type: "json" as const, value: result },
                    },
                  ],
                } as ModelMessage);
              }
            }
          }

          // 哈希循环检测（统一在工具执行后处理）
          const cycleResult = cycleDetector.check(lastInputMsg, toolCalls);

          if (cycleResult.consoleMessage) {
            console.log(cycleResult.consoleMessage);
          }

          if (cycleResult.shouldBlock) {
            pushMessage({
              role: "user",
              content: cycleResult.injectMessage,
            } as ModelMessage);
            keepCalling = false;
          } else if (cycleResult.shouldWarn) {
            pushMessage({
              role: "user",
              content: cycleResult.injectMessage,
            } as ModelMessage);
          }

          // 总量预算：所有工具结果不超过窗口 75%
          enforceToolResultBudget(messages);

          // TTL 修剪：时间过期的只读工具结果做软修剪 / 硬清除
          pruneExpiredToolResults(messages);

          // 清理旧的查询类工具结果，节省上下文
          cleanOldReadOnlyToolResults(messages);
        }
      }

      // 工具结果清理后若上下文仍过长，调用 LLM 压缩早期对话
      await compressConversation(messages, tokenTracker);

      saveSession(messages);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ ${message}`);
      // 撤回本轮对话中已推送的用户消息，避免污染上下文
      messages.pop();
    }
  }

  rl.close();
};

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n💥 致命错误，程序退出: ${message}`);
  process.exit(1);
});
