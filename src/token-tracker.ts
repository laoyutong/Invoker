import type { LanguageModelUsage } from "ai";

import { CONTEXT_WINDOW, PRICING, type PricingTier, TOKEN_BUDGET } from "./constants";

const fmtTokens = (n: number | undefined): string => {
  if (n === undefined) return "?";
  return n.toLocaleString();
};

/** 紧凑格式：1,234 → 1.2k，1,048,576 → 1M */
const fmtTokensCompact = (n: number): string => {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return v === Math.round(v) ? `${v}M` : `${v.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const v = n / 1000;
    return v === Math.round(v) ? `${v}k` : `${v.toFixed(1)}k`;
  }
  return String(n);
};

const fmtCost = (usd: number): string => {
  if (usd === 0) return "$0";
  return `$${usd.toFixed(4)}`;
};

const fmtRate = (rate: number): string => {
  if (!Number.isFinite(rate)) return "N/A";
  return `${rate.toFixed(1)}%`;
};

/** 绘制可视化进度条（20 格） */
const drawBar = (rate: number): string => {
  if (!Number.isFinite(rate)) return "";
  const filled = Math.round(rate / 5); // 0-100 → 0-20
  const empty = 20 - filled;
  return "█".repeat(filled) + "░".repeat(empty);
};

export class TokenTracker {
  private pricing: PricingTier;
  private modelName: string;

  /** 上次 API 调用返回的精确 input token 数（校准基准） */
  private calibratedInput = 0;
  /** 校准后新增消息的粗估 token 数（chars / 4） */
  estimatedNewInput = 0;
  /** 累计 output tokens（每次 API 调用累加） */
  outputTokens = 0;

  /** 累计统计（用于 /usage 汇报） */
  private stepCount = 0;
  private totalNoCacheTokens = 0; // 标准输入（非缓存命中）
  private totalCacheWriteTokens = 0; // 缓存写入
  private totalCacheReadTokens = 0; // 缓存读取
  private totalOutputTokens = 0; // 累计输出

  /** 静态上下文 token 估算（system prompt + tool defs），用于 /context 展示 */
  private systemTokens = 0;
  private toolTokens = 0;

  /**
   * 首次 API 响应后通过精确 inputTokens 反推的静态上下文 token 数。
   * null = 尚未校准，或静态上下文已变更需重新校准。
   */
  private calibratedStaticContext: number | null = null;

  /** 用于检测静态上下文是否变更（对比 system prompt 内容哈希） */
  private lastStaticHash = "";

  constructor(modelName: string) {
    this.modelName = modelName;
    this.pricing = PRICING[modelName] ?? PRICING["deepseek-v4-flash"];
  }

  /** 每次 API 调用返回后校准：用 usage.inputTokens 替换估算值 */
  track(usage: LanguageModelUsage): void {
    this.stepCount++;

    // 累计 token 分类统计
    const noCache = usage.inputTokenDetails?.noCacheTokens ?? 0;
    const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
    const output = usage.outputTokens ?? 0;

    this.totalNoCacheTokens += noCache;
    this.totalCacheWriteTokens += cacheWrite;
    this.totalCacheReadTokens += cacheRead;
    this.totalOutputTokens += output;

    // 单步用量日志
    const detail: string[] = [];
    if (usage.inputTokens) {
      let inputStr = `入 ${fmtTokens(usage.inputTokens)}`;
      if (cacheRead) {
        inputStr += ` (缓存命中 ${fmtTokens(cacheRead)})`;
      }
      detail.push(inputStr);
    }
    if (usage.outputTokens) {
      let outputStr = `出 ${fmtTokens(output)}`;
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

      // 首次或静态上下文变更后：用精确 inputTokens 反推 system+tools token 数
      if (this.calibratedStaticContext === null) {
        // calibratedInput = system + tools + messages（精确）
        // estimatedNewInput = messages 的 chars/4 粗估（将在下面被重置）
        // 反推：system + tools = 精确总量 - 粗估消息量
        this.calibratedStaticContext = Math.max(0, usage.inputTokens - this.estimatedNewInput);
      }
    }
    this.estimatedNewInput = 0;

    // output 是增量的，累加（保留旧字段兼容）
    this.outputTokens += output;

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

  /** 更新静态上下文 token 估算（system prompt + tool definitions），每次构建 prompt 后调用 */
  updateStaticContext(systemChars: number, toolChars: number): void {
    this.systemTokens = Math.ceil(systemChars / 4);
    this.toolTokens = Math.ceil(toolChars / 4);

    // 检测静态上下文是否变更，若变更则标记需要重新校准
    const hash = `${systemChars}:${toolChars}`;
    if (hash !== this.lastStaticHash) {
      this.lastStaticHash = hash;
      this.calibratedStaticContext = null; // 下次 API 响应时重新校准
    }
  }

  /** 格式化输出 Context Usage（上下文窗口占用分析） */
  context(): string {
    const maxTokens = CONTEXT_WINDOW.maxTokens;
    const totalInput = this.calibratedInput + this.estimatedNewInput;

    let systemT: number;
    let toolT: number;
    let messagesT: number;

    if (this.calibratedStaticContext !== null) {
      // 已校准：用精确的 system+tools 总量，按粗估比例拆分
      const staticSum = this.systemTokens + this.toolTokens;
      const ratio = staticSum > 0 ? this.calibratedStaticContext / staticSum : 0;
      systemT = Math.round(this.systemTokens * ratio);
      toolT = Math.round(this.toolTokens * ratio);
      // messages = 精确总输入 - 精确静态部分
      messagesT = Math.max(0, totalInput - this.calibratedStaticContext);
    } else if (this.systemTokens > 0 || this.toolTokens > 0) {
      // 未校准但有粗估值：全用粗估
      systemT = this.systemTokens;
      toolT = this.toolTokens;
      messagesT = Math.max(0, totalInput - systemT - toolT);
    } else if (totalInput > 0) {
      // 连 system/tool 粗估都没有，全部算 messages
      systemT = 0;
      toolT = 0;
      messagesT = totalInput;
    } else {
      // 完全没有任何数据
      const lines: string[] = [];
      lines.push("");
      lines.push(" Context Usage");
      lines.push("");
      lines.push("  No API calls yet — start a conversation to see context usage.");
      return lines.join("\n");
    }

    const total = systemT + toolT + messagesT;
    const pctUsed = total > 0 ? (total / maxTokens) * 100 : 0;

    const barLen = 36;
    const filled = Math.min(barLen, Math.round((pctUsed / 100) * barLen));
    const empty = barLen - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);

    const pct = (part: number) => (total > 0 ? `${((part / total) * 100).toFixed(0)}%` : "0%");
    const labelWidth = 18;
    const pad = (label: string) => label.padEnd(labelWidth);
    const num = (n: number) => fmtTokensCompact(n).padStart(6);

    const lines: string[] = [];
    lines.push("");
    lines.push(" Context Usage");
    lines.push("");
    lines.push(`  ⚙ ${pad("System prompt")} ${num(systemT)} tokens  (${pct(systemT)})`);
    lines.push(`  🔧 ${pad("Tools")} ${num(toolT)} tokens  (${pct(toolT)})`);
    lines.push(`  💬 ${pad("Messages")} ${num(messagesT)} tokens  (${pct(messagesT)})`);
    lines.push(`  ${"─".repeat(labelWidth + 16)}`);
    lines.push(
      `  Total            ${num(total)} / ${fmtTokensCompact(maxTokens)} tokens (${fmtRate(pctUsed)})`,
    );
    lines.push(`  ${bar}  ${fmtRate(pctUsed)} used`);

    return lines.join("\n");
  }

  /** 格式化输出 Usage Summary */
  summary(): string {
    const noCache = this.totalNoCacheTokens;
    const cacheWrite = this.totalCacheWriteTokens;
    const cacheRead = this.totalCacheReadTokens;
    const output = this.totalOutputTokens;

    // 缓存命中率
    const cacheTotal = cacheRead + cacheWrite;
    const hitRate = cacheTotal > 0 ? (cacheRead / cacheTotal) * 100 : 0;

    // 成本计算
    const toPerToken = (pricePerM: number) => pricePerM / 1_000_000;
    const actualCost =
      noCache * toPerToken(this.pricing.input) +
      cacheWrite * toPerToken(this.pricing.cacheWrite) +
      cacheRead * toPerToken(this.pricing.cacheRead) +
      output * toPerToken(this.pricing.output);

    // 假设没有缓存：所有输入都按标准价
    const totalInput = noCache + cacheWrite + cacheRead;
    const withoutCacheCost =
      totalInput * toPerToken(this.pricing.input) + output * toPerToken(this.pricing.output);

    const saved = withoutCacheCost - actualCost;
    const savedRate = withoutCacheCost > 0 ? (saved / withoutCacheCost) * 100 : 0;

    const num = (n: number) => fmtTokensCompact(n).padStart(7);
    const labelWidth = 14;
    const pad = (label: string) => label.padEnd(labelWidth);

    const lines: string[] = [];
    lines.push("");
    lines.push(" Usage Summary");
    lines.push(`  Model          ${this.modelName}`);
    lines.push(`  Steps          ${this.stepCount} 步累计`);
    lines.push("");
    lines.push(`  ◎ ${pad("Input")} ${num(noCache)} tokens`);
    lines.push(`  ◈ ${pad("Cache write")} ${num(cacheWrite)} tokens`);
    lines.push(`  ◉ ${pad("Cache read")} ${num(cacheRead)} tokens  (${fmtRate(hitRate)} hit)`);
    lines.push(`  ◇ ${pad("Output")} ${num(output)} tokens`);
    lines.push("");

    // 可视化进度条
    lines.push(`  Cache hit rate  ${drawBar(hitRate)}  ${fmtRate(hitRate)}`);
    lines.push("");

    // 成本
    lines.push(`  Cost            ${fmtCost(actualCost)}`);
    lines.push(`  Without cache   ${fmtCost(withoutCacheCost)}`);
    lines.push(`  Saved           ${fmtCost(saved)} (${fmtRate(savedRate)} off)`);

    return lines.join("\n");
  }
}
