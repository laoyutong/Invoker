import type { LanguageModelUsage } from "ai";

import { TOKEN_BUDGET } from "./constants";

const fmtTokens = (n: number | undefined): string => {
  if (n === undefined) return "?";
  return n.toLocaleString();
};

export class TokenTracker {
  /** 上次 API 调用返回的精确 input token 数（校准基准） */
  private calibratedInput = 0;
  /** 校准后新增消息的粗估 token 数（chars / 4） */
  estimatedNewInput = 0;
  /** 累计 output tokens（每次 API 调用累加） */
  outputTokens = 0;

  /** 每次 API 调用返回后校准：用 usage.inputTokens 替换估算值 */
  track(usage: LanguageModelUsage): void {
    // 单步用量日志
    const detail: string[] = [];
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

    // 用 API 返回的精确值校准 input（替换之前的校准值 + 粗估值）
    if (usage.inputTokens !== undefined) {
      this.calibratedInput = usage.inputTokens;
    }
    this.estimatedNewInput = 0;

    // output 是增量的，累加
    this.outputTokens += usage.outputTokens ?? 0;

    // 预算追踪
    if (TOKEN_BUDGET.maxTokens > 0) {
      const used = this.used;
      const pct = ((used / TOKEN_BUDGET.maxTokens) * 100).toFixed(1);
      console.log(
        `\n📊 累计 Token: ${fmtTokens(used)} / ${fmtTokens(TOKEN_BUDGET.maxTokens)} (${pct}%)`,
      );
    }

    // 输出校准后的上下文估算
    if (this.estimatedNewInput > 0) {
      console.log(
        `   📐 上下文: 校准 ${fmtTokens(this.calibratedInput)} 入 + 粗估 ${fmtTokens(this.estimatedNewInput)} 未校准 | 累计出 ${fmtTokens(this.outputTokens)}`,
      );
    }
  }

  /** 有新消息加入上下文时粗估 token 数（chars / 4） */
  addEstimate(chars: number): void {
    this.estimatedNewInput += Math.ceil(chars / 4);
  }

  /** 当前估算的 input token 总数 = 校准值 + 粗估值 */
  get inputTokens(): number {
    return this.calibratedInput + this.estimatedNewInput;
  }

  get used(): number {
    return this.inputTokens + this.outputTokens;
  }

  isExhausted(): boolean {
    return TOKEN_BUDGET.maxTokens > 0 && this.used >= TOKEN_BUDGET.maxTokens;
  }
}
