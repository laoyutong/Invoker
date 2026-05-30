export const MAX_TOOL_LOOPS = 20;

export const CYCLE_DETECTION = {
  windowSize: 15, // 滑动窗口大小：只追踪最近 N 轮交互
  warnRepeats: 3, // 同一模式重复 N 次时发出警告
  blockRepeats: 5, // 同一模式重复 N 次时阻断工具调用
} as const;

export const CONTEXT_CLEANUP = {
  /** 未清理的只读工具结果超过此阈值时才触发清理 */
  cleanupThreshold: 10,
  /** 清理时最多保留 N 个最近的结果 */
  keepRecentReadOnlyResults: 3,
} as const;

export const CONTEXT_COMPRESSION = {
  /** 总消息数超过此阈值时触发 LLM 压缩 */
  messageThreshold: 40,
  /** 压缩后至少保留最近 N 条消息不被压缩 */
  keepRecent: 15,
  /** 最少需要压缩的消息条数，避免为少量消息调用 LLM */
  minCompressCount: 8,
} as const;

export const TOKEN_BUDGET = {
  /** 会话最大 token 数，0 = 不限 */
  maxTokens: 0, // 0 = 不限
} as const;
