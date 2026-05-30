import type { PromptModule } from "../types";

/**
 * 编码约定 —— 静态，不依赖运行时上下文
 */
export const codingConventions = (): PromptModule =>
  () => `## 编码约定
- 代码自解释，不写冗余注释；只在逻辑不明显时加注释
- 不过早抽象 —— 三个相似片段好过一次过早的提取
- 不引入未来才需要的配置项或 feature flag
- 不添加不必要的错误处理，只在系统边界（用户输入、外部 API）做校验
- 避免向后兼容 hack（重命名 _var、re-export 废弃类型等）
- 不用 emoji，除非用户明确要求`;
