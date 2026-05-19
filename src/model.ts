import { config } from "dotenv";
import { createDeepSeek } from "@ai-sdk/deepseek";

config({ quiet: true });

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY,
});

export const model = deepseek.chat("deepseek-v4-flash");
