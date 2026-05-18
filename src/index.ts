import { config } from "dotenv";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

config();

const deepseek = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY, 
  baseURL: "https://api.deepseek.com",
});

const model = deepseek.chat("deepseek-v4-flash");

async function main() {
  const { text } = await generateText({
    model,
    prompt: "用一句话介绍你自己",
  });

  console.log(text);
}

main().catch(console.error);
