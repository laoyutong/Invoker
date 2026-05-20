import type { LanguageModelUsage } from "ai";

import { TOKEN_BUDGET } from "./constants";

const fmtTokens = (n: number | undefined): string => {
  if (n === undefined) return "?";
  return n.toLocaleString();
};

export class TokenTracker {
  inputTokens = 0;
  outputTokens = 0;

  track(usage: LanguageModelUsage): void {
    // 单步用量
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

    // 累计
    this.inputTokens += usage.inputTokens ?? 0;
    this.outputTokens += usage.outputTokens ?? 0;

    // 预算追踪
    if (TOKEN_BUDGET.maxTokens > 0) {
      const used = this.inputTokens + this.outputTokens;
      const pct = ((used / TOKEN_BUDGET.maxTokens) * 100).toFixed(1);
      console.log(
        `\n📊 累计 Token: ${fmtTokens(used)} / ${fmtTokens(TOKEN_BUDGET.maxTokens)} (${pct}%) | 入 ${fmtTokens(this.inputTokens)} | 出 ${fmtTokens(this.outputTokens)}`,
      );
    }
  }

  get used(): number {
    return this.inputTokens + this.outputTokens;
  }

  isExhausted(): boolean {
    return TOKEN_BUDGET.maxTokens > 0 && this.used >= TOKEN_BUDGET.maxTokens;
  }
}
