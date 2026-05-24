import { jsonSchema, tool } from "ai";
import TurndownService from "turndown";
import type { ToolDefinition } from "./index";

export const fetchUrlTool = tool({
  description:
    "抓取网页内容，获取 URL 对应的 HTML 并转换为 Markdown。" +
    "适用于获取文档、API 响应、网页正文等。",
  inputSchema: jsonSchema<{ url: string }>({
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "要抓取的网页 URL（支持 http/https）",
      },
    },
    required: ["url"],
  }),
});

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

export async function executeFetchUrl(input: { url: string }) {
  let url = input.url.trim();

  // 自动补全协议
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Invoker/1.0 (fetcher)",
        Accept: "text/html, application/json, text/plain, */*",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return {
        url,
        status: response.status,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const json = await response.json();
      return {
        url,
        status: response.status,
        contentType: "application/json",
        data: json,
      };
    }

    const html = await response.text();

    if (contentType.includes("text/html")) {
      const markdown = turndownService.turndown(html);
      return {
        url,
        status: response.status,
        contentType: "text/html",
        text: markdown.slice(0, 20_000),
        truncated: markdown.length > 20_000,
      };
    }

    // 纯文本或其他格式
    return {
      url,
      status: response.status,
      contentType,
      text: html.slice(0, 20_000),
      truncated: html.length > 20_000,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "AbortError") {
      return { url, error: "请求超时（15 秒）" };
    }
    return { url, error: `请求失败: ${message}` };
  }
}

export const fetchUrlConfig = {
  name: "fetch_url",
  description:
    "抓取网页内容。传入 URL，返回网页的 Markdown 文本（自动转换 HTML 为 Markdown）。" +
    "适用于查阅在线文档、API 响应、博客文章等。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要抓取的网页 URL（支持 http/https）" },
    },
    required: ["url"],
  },
  execute: (input: any) => executeFetchUrl(input as { url: string }),
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 8000,
  schema: fetchUrlTool,
} satisfies ToolDefinition & { schema: unknown };
