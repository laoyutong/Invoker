import type { ModelMessage } from "ai";

const RECENT_COUNT = 6;

const renderContent = (content: unknown, maxLen = 200): string => {
  if (typeof content === "string") return content.slice(0, maxLen);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        switch (part.type) {
          case "text":
            return (part.text as string).slice(0, maxLen);
          case "reasoning":
            return `[思考] ${(part.text as string).slice(0, 100)}`;
          case "tool-call":
            return `[调用 ${part.toolName}]`;
          case "tool-result":
            return "[工具结果]";
          default:
            return "";
        }
      })
      .filter(Boolean)
      .join(" ");
  }
  return String(content).slice(0, maxLen);
};

export const renderRecentMessages = (messages: ModelMessage[]): void => {
  const recent = messages.slice(-RECENT_COUNT);
  if (recent.length === 0) return;

  const label: Record<string, string> = {
    user: "👤",
    assistant: "🤖",
    tool: "🔧",
  };

  console.log(`\n── 最近 ${recent.length} 条消息 ──`);
  for (const msg of recent) {
    const role = msg.role;
    const prefix = label[role] ?? role;
    const text = renderContent(msg.content);
    if (text) {
      console.log(`  ${prefix}  ${text}`);
    }
  }
  console.log("──────────\n");
};
