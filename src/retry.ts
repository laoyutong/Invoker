import { APICallError, RetryError } from "ai";

export const isRetryable = (error: unknown): boolean => {
  // AI SDK 重试耗尽时抛出 RetryError，原始错误在 lastError 里
  if (RetryError.isInstance(error)) {
    return isRetryable(error.lastError);
  }

  // AI SDK 结构化错误：直接读 statusCode，不在 message 里
  if (APICallError.isInstance(error)) {
    return error.isRetryable;
  }

  if (!(error instanceof Error)) return false;

  const message = error.message || "";

  // HTTP 状态码判断（message 中包含状态码的场景）
  const statusMatch = message.match(/(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if ([429, 529, 408].includes(status)) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }

  // 网络错误
  if (message.includes("ECONNRESET") || message.includes("EPIPE")) return true;
  if (message.includes("ETIMEDOUT") || message.includes("timeout")) return true;
  if (message.includes("fetch failed") || message.includes("network")) return true;
  // AI SDK 会把流式错误包装成 NoOutputGeneratedError
  if (message.includes("No output generated")) return true;

  return false;
};

export interface RetryOptions {
  /** 最大重试次数（不含首次），默认 5 */
  maxRetries?: number;
  /** 初始延迟毫秒，默认 1000 */
  initialDelay?: number;
  /** 退避因子，默认 2 */
  backoffFactor?: number;
  /** 最大延迟毫秒上限，默认 30000 */
  maxDelay?: number;
}

/**
 * 对异步操作执行指数退避重试。
 * - 遇到可重试错误时，按 initialDelay * backoffFactor^attempt 延迟后重试
 * - 遇到不可重试错误时，立即抛出
 * - 重试次数耗尽后，抛出原始错误
 */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const { maxRetries = 5, initialDelay = 1000, backoffFactor = 2, maxDelay = 30000 } = options;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      const delay = Math.min(initialDelay * backoffFactor ** attempt, maxDelay);
      // 给延迟加上 ±20% 的随机抖动，避免惊群
      const jitter = delay * 0.2 * (Math.random() * 2 - 1);
      const finalDelay = Math.round(delay + jitter);
      console.error(
        `\n⚠️ API 调用失败，${finalDelay}ms 后第 ${attempt + 1} 次重试: ${error instanceof Error ? error.message : String(error)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, finalDelay));
    }
  }

  // 最后一次尝试，不再捕获——无论成功或失败都直接返回/抛出
  return fn();
};
