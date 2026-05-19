export const MAX_TOOL_LOOPS = 20;

export const CYCLE_DETECTION = {
  windowSize: 15,  // 滑动窗口大小：只追踪最近 N 轮交互
  warnRepeats: 5,  // 同一模式重复 N 次时发出警告
  blockRepeats: 10, // 同一模式重复 N 次时阻断工具调用
} as const;
