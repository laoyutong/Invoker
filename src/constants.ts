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

export const CONTEXT_WINDOW = {
  /** 模型上下文窗口 token 数 */
  maxTokens: 1_048_576, // 1M
} as const;

export const TOOL_RESULT_BUDGET = {
  /** 单个工具结果的字符数上限 = 上下文窗口 × 此比例 */
  maxSingleResultRatio: 0.5,
  /** 所有工具结果的总字符数上限 = 上下文窗口 × 此比例 */
  maxTotalResultsRatio: 0.75,
} as const;

export const TOOL_RESULT_TTL = {
  /** 软修剪：超过此时间（毫秒）的工具结果做 Head/Tail 保留 */
  softPruneMs: 5 * 60 * 1000,
  /** 软修剪保留的头部字符数 */
  softPruneHeadChars: 1500,
  /** 软修剪保留的尾部字符数 */
  softPruneTailChars: 1500,
  /** 硬清除：超过此时间（毫秒）的工具结果完全替换为占位符 */
  hardClearMs: 10 * 60 * 1000,
} as const;

export const CONTEXT_COMPRESSION = {
  /** 总消息数超过此阈值时触发 LLM 压缩 */
  messageThreshold: 40,
  /** 压缩后至少保留最近 N 条消息不被压缩 */
  keepRecent: 15,
  /** 最少需要压缩的消息条数，避免为少量消息调用 LLM */
  minCompressCount: 8,
} as const;

export interface PricingTier {
  /** 每百万 token 价格（美元） */
  input: number;       // 标准输入（非缓存命中）
  cacheWrite: number;  // 缓存写入
  cacheRead: number;   // 缓存读取
  output: number;      // 输出 token
}

/** 各模型的每百万 token 定价（美元） */
export const PRICING: Record<string, PricingTier> = {
  "deepseek-v4-flash": {
    input: 0.14,       // 标准输入
    cacheWrite: 0.14,  // 缓存写入（DeepSeek 不加价）
    cacheRead: 0.014,  // 缓存读取（10% 定价）
    output: 1.10,      // 输出
  },
};

export const TOKEN_BUDGET = {
  /** 会话最大 token 数，0 = 不限 */
  maxTokens: 0, // 0 = 不限
} as const;
