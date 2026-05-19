import * as readline from "node:readline";
import { type ModelMessage, streamText } from "ai";

import "./model";
import { MAX_TOOL_LOOPS } from "./constants";
import { CycleDetector } from "./cycle-detector";
import { model } from "./model";
import { SYSTEM_PROMPT } from "./prompt";
import { withRetry } from "./retry";
import { toolRegistry, tools } from "./tools";

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

async function main() {
  console.log('输入对话内容，输入 "exit" 退出\n');

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

        const { fullText, reasoningText, toolCalls } = await withRetry(async () => {
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
          const toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = [];

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
            }
          }

          // 流式错误不会自动抛出，需要手动检测后抛给 withRetry 处理
          if (streamError) throw streamError;

          return { fullText, reasoningText, toolCalls };
        });

        if (toolCalls.length === 0) {
          process.stdout.write("\n\n");
          messages.push({ role: "assistant", content: fullText });
          keepCalling = false;
        } else {
          console.log(`\n🔧 执行工具中...`);

          // 保存循环检测所需的"输入"消息（assistant 看到的上一条消息）
          const lastInputMsg = messages[messages.length - 1];

          // 推送 assistant 消息
          const contentParts: Array<
            | { type: "reasoning"; text: string }
            | { type: "text"; text: string }
            | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
          > = [];
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
