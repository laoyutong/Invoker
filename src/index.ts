import * as readline from "node:readline";
import { type LanguageModelUsage, type ModelMessage, streamText } from "ai";

import "./model";
import { compressConversation } from "./compress";
import { MAX_TOOL_LOOPS } from "./constants";
import { cleanupToolResults } from "./context-manager";
import { CycleDetector } from "./cycle-detector";
import { activateDeferredTools, promptRuntimeContext } from "./deferred-tools";
import {
  clearMemory,
  forgetMemory,
  loadMemory,
  renderMemory,
  updateLongTermMemory,
} from "./memory";
import { initMCP } from "./mcp";
import { type AssistantContentPart, isToolResultPart, type ToolCallEntry } from "./message-parts";
import { MODEL_NAME, model } from "./model";
import { buildPrompt } from "./prompt";
import { withRetry } from "./retry";
import { getSessionId, initSession, loadSession, saveSession, sessionExists } from "./session";
import { renderRecentMessages } from "./session-view";
import { TokenTracker } from "./token-tracker";
import { executeToolCalls } from "./tool-executor";
import { logToolCall } from "./tool-results";
import { toolRegistry } from "./tools";
import { bashConfig } from "./tools/bash";
import { editFileConfig } from "./tools/edit-file";
import { fetchUrlConfig } from "./tools/fetch-url";
import { findFilesConfig } from "./tools/find-files";
import { globConfig } from "./tools/glob";
import { grepConfig } from "./tools/grep";
import { readFileConfig } from "./tools/read-file";
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
let memoryEnabled = true;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (): Promise<string> => {
  return new Promise((resolve) => {
    rl.question("> ", (answer) => {
      resolve(answer);
    });
  });
};

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
};

/** 组装当前运行时上下文并构建 system prompt */
const buildSystemPrompt = (): string => {
  return buildPrompt(promptRuntimeContext(messages.length, { includeMemory: memoryEnabled }));
};

const main = async () => {
  await initMCP();

  initSession({ continueSession: shouldContinue, targetId: targetSessionId });
  initOrRestoreSession();

  const memoryCount = loadMemory().items.length;
  if (memoryCount > 0) {
    console.log(`🧠 已加载 ${memoryCount} 条跨会话记忆`);
  }

  console.log('输入对话内容，"exit" 退出，"/usage" 用量，"/context" 上下文，"/memory" 记忆\n');

  const tokenTracker = new TokenTracker(MODEL_NAME);

  /** 推送消息到上下文，同时用 chars/4 粗估 token 增量 */
  const pushMessage = (msg: ModelMessage): void => {
    messages.push(msg);
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    tokenTracker.addEstimate(text.length);

    // 记录工具结果时间戳，用于 TTL 修剪
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (isToolResultPart(part) && typeof part.toolCallId === "string") {
          toolResultTimestamps.set(part.toolCallId, Date.now());
        }
      }
    }
  };

  while (true) {
    const input = await ask();

    if (input.toLowerCase() === "exit") {
      if (memoryEnabled) {
        await updateLongTermMemory(messages, { sessionId: getSessionId(), force: true });
      }
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

    if (input.trim().startsWith("/memory")) {
      const [, command, arg] = input.trim().split(/\s+/, 3);

      if (!command) {
        console.log(renderMemory());
        continue;
      }

      if (command === "off") {
        memoryEnabled = false;
        console.log("🧠 本次运行已关闭跨会话记忆注入与写入");
        continue;
      }

      if (command === "on") {
        memoryEnabled = true;
        console.log("🧠 本次运行已开启跨会话记忆注入与写入");
        continue;
      }

      if (command === "clear") {
        clearMemory();
        console.log("🧠 已清空跨会话记忆");
        continue;
      }

      if (command === "forget") {
        if (!arg) {
          console.log("用法：/memory forget <id>");
          continue;
        }
        console.log(forgetMemory(arg) ? `🧠 已删除记忆 ${arg}` : `⚠️ 未找到记忆 ${arg}`);
        continue;
      }

      if (command === "extract") {
        await updateLongTermMemory(messages, { sessionId: getSessionId(), force: true });
        continue;
      }

      console.log(
        "用法：/memory | /memory on | /memory off | /memory extract | /memory forget <id> | /memory clear",
      );
      continue;
    }

    if (!input.trim()) continue;

    const turnStartIndex = messages.length;
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

          await executeToolCalls(toolCalls, pushMessage);

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

          cleanupToolResults(messages, toolResultTimestamps);
        }
      }

      // 工具结果清理后若上下文仍过长，调用 LLM 压缩早期对话
      await compressConversation(messages, tokenTracker);

      if (memoryEnabled) {
        await updateLongTermMemory(messages, { sessionId: getSessionId() });
      }

      saveSession(messages);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ ${message}`);
      // 撤回本轮已推送的所有消息，避免留下半截 tool-call/tool-result 配对。
      messages.splice(turnStartIndex);
    }
  }

  rl.close();
};

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n💥 致命错误，程序退出: ${message}`);
  process.exit(1);
});
