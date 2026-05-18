import { config } from "dotenv";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, ModelMessage } from "ai";
import * as readline from "node:readline";

config({ quiet: true });

const deepseek = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

const model = deepseek.chat("deepseek-v4-flash");

const SYSTEM_PROMPT = `你是 Invoker，一个专注于软件开发的 AI 助手。
你说话简洁直接，喜欢用代码示例来解释问题。
如果用户的问题不够清晰，你会反问而不是瞎猜。`;

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

    const { textStream } = streamText({
      model,
      system: SYSTEM_PROMPT,
      messages,
    });

    let fullResponse = "";
    for await (const chunk of textStream) {
      process.stdout.write(chunk);
      fullResponse += chunk;
    }
    process.stdout.write("\n\n");

    messages.push({ role: "assistant", content: fullResponse });
  }

  rl.close();
}

main().catch(console.error);
