import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

import { CYCLE_DETECTION } from "./constants";

function shortHash(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("base64url").slice(0, 16);
}

/** 规范化消息内容，剔除 toolCallId 等易变字段 */
function normalizeMessage(msg: ModelMessage): unknown {
  if (msg.role === "user") {
    return { r: "u", c: msg.content };
  }
  if (msg.role === "assistant") {
    if (typeof msg.content === "string") {
      return { r: "a", c: msg.content };
    }
    const parts = (msg.content as Array<Record<string, unknown>>).map((p) => {
      if (p.type === "tool-call") return { t: "tc", n: p.toolName, i: p.input };
      if (p.type === "text") return { t: "tx", c: p.text };
      if (p.type === "reasoning") return { t: "rs", c: p.text };
      return p;
    });
    return { r: "a", p: parts };
  }
  if (msg.role === "tool") {
    const parts = (msg.content as Array<Record<string, unknown>>).map((p) => {
      if (p.type === "tool-result") return { t: "tr", n: p.toolName, o: p.output };
      return p;
    });
    return { r: "t", p: parts };
  }
  return msg;
}

export interface CycleResult {
  repeatCount: number;
  shouldWarn: boolean;
  shouldBlock: boolean;
  /** 注入给模型看到的消息（warning / block 二选一） */
  injectMessage: string | null;
  /** 打印到控制台的消息 */
  consoleMessage: string | null;
}

export class CycleDetector {
  private window: string[] = [];

  reset(): void {
    this.window = [];
  }

  check(
    lastInputMsg: ModelMessage,
    toolCalls: Array<{ toolName: string; input: unknown }>,
  ): CycleResult {
    const inputFingerprint = shortHash(normalizeMessage(lastInputMsg));
    const outputFingerprint = shortHash(toolCalls.map((tc) => ({ n: tc.toolName, i: tc.input })));
    const cycleKey = `${inputFingerprint}|${outputFingerprint}`;

    this.window.push(cycleKey);
    if (this.window.length > CYCLE_DETECTION.windowSize) {
      this.window.shift();
    }

    const repeatCount = this.window.filter((k) => k === cycleKey).length;
    const blockRepeats = CYCLE_DETECTION.blockRepeats;

    let injectMessage: string | null = null;
    let consoleMessage: string | null = null;

    if (repeatCount >= blockRepeats) {
      consoleMessage = `\n⛔ 相同输入→输出模式重复 ${repeatCount} 次，阻断工具调用并强制终止`;
      injectMessage = `[系统检测] 你已经连续 ${repeatCount} 次用相同参数调用相同工具，陷入死循环。请立即停止调用工具，直接基于已有信息给出回答。`;
    } else if (repeatCount === CYCLE_DETECTION.warnRepeats) {
      consoleMessage = `\n⚠️ 检测到重复模式（${repeatCount}/${blockRepeats}），已提醒模型`;
      injectMessage = `[系统检测] 你已重复调用相同工具 ${repeatCount} 次。请换一种方法，或直接基于已有信息给出回答，不要再继续调用相同工具。`;
    }

    return {
      repeatCount,
      shouldWarn: repeatCount === CYCLE_DETECTION.warnRepeats,
      shouldBlock: repeatCount >= blockRepeats,
      injectMessage,
      consoleMessage,
    };
  }
}
