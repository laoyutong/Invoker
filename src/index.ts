import { streamText, ModelMessage } from "ai";
import * as readline from "node:readline";

import "./model";
import { model } from "./model";
import { SYSTEM_PROMPT } from "./prompt";
import { weatherTool, executeWeather } from "./tools/weather";
import { MAX_TOOL_LOOPS } from "./constants";

const messages: ModelMessage[] = [];

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

function logToolResult(name: string, output: unknown) {
  console.log(`   └─ 结果: ${JSON.stringify(output)}`);
}

type ToolCall = { toolCallId: string; toolName: string; input: unknown };

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

    // 手动工具调用循环 — 每次 streamText 调用只走一步
    let loopCount = 0;
    let keepCalling = true;
    while (keepCalling) {
      if (loopCount >= MAX_TOOL_LOOPS) {
        console.log(`\n⚠️ 工具调用已达上限 ${MAX_TOOL_LOOPS} 次，强制终止`);
        messages.push({ role: "assistant", content: "工具调用次数过多，已终止。" } as ModelMessage);
        break;
      }
      loopCount++;
      const { fullStream } = streamText({
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools: { weather: weatherTool },
      });

      let fullText = "";
      let reasoningText = "";
      const toolCalls: ToolCall[] = [];

      for await (const part of fullStream) {
        switch (part.type) {
          case "text-delta":
            process.stdout.write(part.text);
            fullText += part.text;
            break;

          case "reasoning-delta":
            reasoningText += part.text;
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

      if (toolCalls.length === 0) {
        // 没有工具调用 — 纯文本回复，本轮结束
        process.stdout.write("\n\n");
        messages.push({ role: "assistant", content: fullText });
        keepCalling = false;
      } else {
        // 模型想要调用工具 — 手动执行
        console.log(`\n🔧 执行工具中...`);

        // 推送 assistant 消息：reasoning + text + tool-call
        const contentParts: any[] = [];
        if (reasoningText) contentParts.push({ type: "reasoning", text: reasoningText });
        if (fullText) contentParts.push({ type: "text", text: fullText });
        for (const tc of toolCalls) {
          contentParts.push({ type: "tool-call", ...tc });
        }
        messages.push({ role: "assistant", content: contentParts } as ModelMessage);

        // 执行工具并推送结果
        for (const tc of toolCalls) {
          if (tc.toolName === "weather") {
            const result = executeWeather(tc.input as { city: string });
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
        }

        // 继续循环 — 下一次 streamText 调用会携带工具结果
      }
    }
  }

  rl.close();
}

main().catch(console.error);
