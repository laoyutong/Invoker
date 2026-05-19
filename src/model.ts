import { createDeepSeek } from "@ai-sdk/deepseek";
import { config } from "dotenv";

config({ quiet: true });

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY,
});

export const model = deepseek.chat("deepseek-v4-flash");
