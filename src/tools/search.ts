import { toolRegistry } from "./index";

export interface ToolSearchResult {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe: boolean;
  isReadOnly: boolean;
}

/**
 * 按关键词搜索已注册的工具，返回匹配工具的完整 Schema。
 * 匹配范围：工具名、描述、searchHint（不区分大小写）。
 */
export function searchTools(keywords: string[]): ToolSearchResult[] {
  if (keywords.length === 0) return [];

  const results: ToolSearchResult[] = [];
  const seen = new Set<string>();

  for (const name of toolRegistry.names()) {
    const tool = toolRegistry.lookup(name);
    if (!tool) continue;

    const searchText = [tool.searchHint ?? "", tool.description].join(" ").toLowerCase();

    const matches = keywords.every((kw) => searchText.includes(kw.toLowerCase()));
    if (!matches) continue;

    if (seen.has(tool.name)) continue;
    seen.add(tool.name);

    results.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      isConcurrencySafe: tool.isConcurrencySafe ?? false,
      isReadOnly: tool.isReadOnly ?? false,
    });
  }

  return results;
}

/**
 * 按关键词搜索延迟加载的（尚未激活的）工具，匹配时自动激活。
 * 返回被激活的工具信息。已激活的工具不会重复处理。
 */
export function activateByKeywords(keywords: string[]): ToolSearchResult[] {
  if (keywords.length === 0) return [];

  const results: ToolSearchResult[] = [];

  for (const name of toolRegistry.deferredNames()) {
    const tool = toolRegistry.lookup(name);
    if (!tool) continue;

    const searchText = [tool.searchHint ?? "", tool.description].join(" ").toLowerCase();

    const matches = keywords.every((kw) => searchText.includes(kw.toLowerCase()));
    if (!matches) continue;

    toolRegistry.activate(name);
    results.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      isConcurrencySafe: tool.isConcurrencySafe ?? false,
      isReadOnly: tool.isReadOnly ?? false,
    });
  }

  return results;
}
