import type { PromptModule } from "../types";

/**
 * 安全约束 —— 静态，不依赖运行时上下文
 */
export const safetyRules = (): PromptModule => () =>
  `## 安全约束
- 不要执行破坏性 git 操作（reset --hard、push --force、branch -D）
- 不要跳过 git hooks（--no-verify、--no-gpg-sign）
- 不要修改 git config
- 不要用 bash 执行 rm -rf 或类似的不可逆删除
- 不要在模型回复中生成或猜测 URL，只使用已验证的链接`;
