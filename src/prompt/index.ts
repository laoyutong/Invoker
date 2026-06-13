import type { PromptContext, PromptModule } from "./types";

export type { PromptContext, PromptModule } from "./types";

export class PromptBuilder {
  private pipes: { name: string; fn: PromptModule }[] = [];

  pipe(name: string, fn: PromptModule): this {
    this.pipes.push({ name, fn });
    return this;
  }

  build(ctx: PromptContext): string {
    const parts: string[] = [];
    for (const { fn } of this.pipes) {
      const text = fn(ctx);
      if (text) parts.push(text);
    }
    return parts.join("\n\n");
  }
}

// ============ 内置模块（先静后动） ============

import { codingConventions } from "./modules/coding-conventions";
import { coreRules } from "./modules/core";
import { deferredTools } from "./modules/deferred-tools";
import { safetyRules } from "./modules/safety-rules";
import { toolGuide } from "./modules/tool-guide";

const builder = new PromptBuilder()
  // ---- 静态 sections ----
  .pipe("coreRules", coreRules())
  .pipe("safetyRules", safetyRules())
  .pipe("toolGuide", toolGuide())
  .pipe("codingConventions", codingConventions())
  // ---- 动态 sections ----
  .pipe("deferredTools", deferredTools());

export const buildPrompt = (ctx: PromptContext): string => builder.build(ctx);
