import { getSessionId } from "./session";
import { toolRegistry } from "./tools";
import { activateByKeywords } from "./tools/search";

const STOP_WORDS = new Set([
  "的",
  "了",
  "在",
  "是",
  "我",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "一个",
  "上",
  "也",
  "很",
  "到",
  "说",
  "要",
  "去",
  "你",
  "会",
  "着",
  "没有",
  "看",
  "好",
  "自己",
  "这",
  "他",
  "她",
  "它",
  "们",
  "那",
  "些",
  "什么",
  "怎么",
  "如何",
  "可以",
  "能",
  "请",
  "帮",
  "让",
  "用",
  "把",
  "给",
  "a",
  "an",
  "the",
  "is",
  "of",
  "to",
  "in",
  "for",
  "and",
  "or",
  "with",
  "be",
  "it",
  "on",
  "at",
  "by",
  "from",
  "this",
  "that",
  "what",
  "which",
]);

const extractKeywords = (input: string): string[] => {
  const byDelimiter = input.split(/[\s,，。！？、；：""''（）()[\]{}<>《》.!?;:]+/);
  const alphaNumeric = input.match(/[a-zA-Z0-9_]+/g) ?? [];
  const tokens = [...byDelimiter, ...alphaNumeric]
    .filter((t) => t.length >= 2)
    .filter((t) => !STOP_WORDS.has(t.toLowerCase()));
  return [...new Set(tokens)];
};

export const buildDeferredToolSummary = (): string => {
  return toolRegistry
    .deferredNames()
    .map((name) => {
      const t = toolRegistry.lookup(name);
      const hint = t?.searchHint ? `（关键词: ${t.searchHint}）` : "";
      return `- ${name}: ${t?.description ?? ""}${hint}`;
    })
    .join("\n");
};

export const promptRuntimeContext = (messageCount: number) => ({
  toolCount: toolRegistry.activeNames().length,
  deferredToolSummary: buildDeferredToolSummary(),
  sessionMessageCount: messageCount,
  sessionId: getSessionId(),
});

export const activateDeferredTools = (input: string): void => {
  const keywords = extractKeywords(input);
  const activatedSet = new Set<string>();
  const activatedNames: string[] = [];

  for (const kw of keywords) {
    for (const t of activateByKeywords([kw])) {
      if (!activatedSet.has(t.name)) {
        activatedSet.add(t.name);
        activatedNames.push(t.name);
      }
    }
  }

  if (activatedNames.length > 0) {
    console.log(`🔓 激活延迟工具: ${activatedNames.join(", ")}`);
  }
};
