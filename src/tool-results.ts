export const truncateResult = (
  output: unknown,
  maxChars: number,
): { truncated: boolean; text: string; skipped: number } => {
  const text = JSON.stringify(output);
  if (text.length <= maxChars) {
    return { truncated: false, text, skipped: 0 };
  }

  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = maxChars - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  const skipped = text.length - maxChars;

  return {
    truncated: true,
    text: `${head}…[省略 ${skipped} 字符]…${tail}`,
    skipped,
  };
};

export const logToolCall = (name: string, input: unknown): void => {
  console.log(`\n📦 模型调用工具: ${name}`);
  console.log(`   └─ 入参: ${JSON.stringify(input)}`);
};

export const logToolResult = (_name: string, output: unknown, maxChars?: number): void => {
  if (!maxChars) {
    console.log(`   └─ 结果: ${JSON.stringify(output)}`);
    return;
  }
  const { text } = truncateResult(output, maxChars);
  console.log(`   └─ 结果: ${text}`);
};
