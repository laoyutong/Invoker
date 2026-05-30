import type { PromptModule } from "../types";

/**
 * 工具使用指南 —— 静态，工具语义不随运行时变化
 */
export const toolGuide = (): PromptModule =>
  () => `## 工具使用指南
- 读文件类工具（read_file、glob、grep）并发安全，尽量并行调用以减少往返
- 有专用工具时优先使用，不要用 bash 替代（如用 glob/grep 而非 ls/find/grep 命令）
- 编辑文件前必须先用 read_file 读取最新内容
- 优先用 edit_file 做局部修改，避免 write_file 全量覆写
- bash 工具超时默认 2 分钟，长时间任务用 run_in_background
- 工具结果自动截断规则：
  - 单条结果不超过上下文窗口 50%，超限做 Head/Tail 分割（头 60% + 尾 40%）
  - 所有工具结果总字符数不超过上下文窗口 75%，超限从最老结果开始清理
  - 被截断的结果带有 _truncated 标记或 [tool result truncated] 占位符
- 工具结果时间衰减（只读类工具：read_file、glob、grep 等）：
  - 超过 5 分钟 → 软修剪，保留头尾各 1500 字符，中间显示 [soft pruned]
  - 超过 10 分钟 → 硬清除，整个结果替换为 [tool result expired: 工具名]
  - 模型应优先使用最新的工具结果；看到过期标记时应重新执行工具获取新数据`;
