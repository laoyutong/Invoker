import * as readline from "node:readline";
import { type LanguageModelUsage, type ModelMessage, streamText } from "ai";

import "./model";
import { MAX_TOOL_LOOPS, TOKEN_BUDGET } from "./constants";
import { CycleDetector } from "./cycle-detector";
import { model } from "./model";
import { SYSTEM_PROMPT } from "./prompt";
import { withRetry } from "./retry";
import { toolRegistry, tools } from "./tools";

type ToolCallEntry = { toolCallId: string; toolName: string; input: unknown };

type AssistantContentPart =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };

const messages: ModelMessage[] = [];
const cycleDetector = new CycleDetector();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(): Promise<string> {
  return new Promise((resolve) => {
    rl.question("> ", (answer) => {
      resolve(answer);
    });
  });
}

function logToolCall(name: string, input: unknown) {
  console.log(`\n📦 模型调用工具: ${name}`);
  console.log(`   └─ 入参: ${JSON.stringify(input)}`);
}

function logToolResult(_name: string, output: unknown) {
  console.log(`   └─ 结果: ${JSON.stringify(output)}`);
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return "?";
  return n.toLocaleString();
}

function logStepUsage(usage: LanguageModelUsage) {
  const detail = [];
  if (usage.inputTokens) {
    let inputStr = `入 ${fmtTokens(usage.inputTokens)}`;
    if (usage.inputTokenDetails?.cacheReadTokens) {
      inputStr += ` (缓存命中 ${fmtTokens(usage.inputTokenDetails.cacheReadTokens)})`;
    }
    detail.push(inputStr);
  }
  if (usage.outputTokens) {
    let outputStr = `出 ${fmtTokens(usage.outputTokens)}`;
    if (usage.outputTokenDetails?.reasoningTokens) {
      outputStr += ` (其中推理 ${fmtTokens(usage.outputTokenDetails.reasoningTokens)})`;
    }
    detail.push(outputStr);
  }
  const total = fmtTokens(usage.totalTokens);
  console.log(`\n\n⚡ Token: ${detail.join(" | ")} | 合计 ${total}`);
}

function logCumulativeUsage(
  used: number,
  budget: number,
  inputTokens: number,
  outputTokens: number,
) {
  const pct = ((used / budget) * 100).toFixed(1);
  console.log(
    `\n📊 累计 Token: ${fmtTokens(used)} / ${fmtTokens(budget)} (${pct}%) | 入 ${fmtTokens(inputTokens)} | 出 ${fmtTokens(outputTokens)}`,
  );
}

async function main() {
  console.log('输入对话内容，输入 "exit" 退出\n');

  const cumulative = { inputTokens: 0, outputTokens: 0 };

  while (true) {
    const input = await ask();

    if (input.toLowerCase() === "exit") {
      console.log("再见！");
      break;
    }

    if (!input.trim()) continue;

    messages.push({ role: "user", content: input });

    let loopCount = 0;
    let keepCalling = true;
    cycleDetector.reset();

    try {
      while (keepCalling) {
        if (loopCount >= MAX_TOOL_LOOPS) {
          console.log(`\n⚠️ 工具调用已达上限 ${MAX_TOOL_LOOPS} 次，强制终止`);
          messages.push({
            role: "assistant",
            content: "工具调用次数过多，已终止。",
          } as ModelMessage);
          break;
        }
        loopCount++;

        const { fullText, reasoningText, toolCalls, streamUsage } = await withRetry(async () => {
          const { fullStream } = streamText({
            model,
            system: SYSTEM_PROMPT,
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
          logStepUsage(streamUsage);
          cumulative.inputTokens += streamUsage.inputTokens ?? 0;
          cumulative.outputTokens += streamUsage.outputTokens ?? 0;

          if (TOKEN_BUDGET.maxTokens > 0) {
            const used = cumulative.inputTokens + cumulative.outputTokens;
            logCumulativeUsage(
              used,
              TOKEN_BUDGET.maxTokens,
              cumulative.inputTokens,
              cumulative.outputTokens,
            );

            if (used >= TOKEN_BUDGET.maxTokens) {
              console.log("🛑 本轮 Token 预算已耗尽\n");
              process.stdout.write("\n\n");
              messages.push({
                role: "assistant",
                content: fullText || "已达到 Token 预算上限。",
              } as ModelMessage);
              keepCalling = false;
              continue;
            }
          }
        }

        if (toolCalls.length === 0) {
          process.stdout.write("\n\n");
          messages.push({ role: "assistant", content: fullText });
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
          messages.push({ role: "assistant", content: contentParts } as ModelMessage);

          // 执行工具并推送结果
          for (const tc of toolCalls) {
            const entry = toolRegistry[tc.toolName];
            if (!entry) continue;

            const result = entry.execute(tc.input);
            logToolResult(tc.toolName, result);
            messages.push({
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

          // 哈希循环检测（统一在工具执行后处理）
          const cycleResult = cycleDetector.check(lastInputMsg, toolCalls);

          if (cycleResult.consoleMessage) {
            console.log(cycleResult.consoleMessage);
          }

          if (cycleResult.shouldBlock) {
            messages.push({
              role: "user",
              content: cycleResult.injectMessage,
            } as ModelMessage);
            keepCalling = false;
          } else if (cycleResult.shouldWarn) {
            messages.push({
              role: "user",
              content: cycleResult.injectMessage,
            } as ModelMessage);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ ${message}`);
      // 撤回本轮对话中已推送的用户消息，避免污染上下文
      messages.pop();
    }
  }

  rl.close();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n💥 致命错误，程序退出: ${message}`);
  process.exit(1);
});
