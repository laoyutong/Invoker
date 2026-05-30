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
- 工具结果会被截断，注意 _truncated 标记`;
