import { createDeepSeek } from "@ai-sdk/deepseek";
import { config } from "dotenv";

config({ quiet: true });

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY,
});

export const MODEL_NAME = "deepseek-v4-flash";
export const model = deepseek.chat(MODEL_NAME);
