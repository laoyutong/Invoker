import * as fs from "node:fs";
import * as path from "node:path";

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpConfig {
  type: "sse" | "streamableHttp";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

function isStdioConfig(config: McpServerConfig): config is McpStdioConfig {
  return "command" in config;
}

/**
 * 加载 .mcp.json 配置文件，不存在时返回空配置
 */
export function loadConfig(): McpConfig {
  const configPath = path.resolve(process.cwd(), ".mcp.json");

  if (!fs.existsSync(configPath)) {
    return { mcpServers: {} };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    if (!config.mcpServers || typeof config.mcpServers !== "object") {
      console.warn("⚠️ .mcp.json 缺少 mcpServers 字段，跳过 MCP 初始化");
      return { mcpServers: {} };
    }

    for (const [name, server] of Object.entries(config.mcpServers)) {
      validateServerConfig(name, server as McpServerConfig);
    }

    return config as McpConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { mcpServers: {} };
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ .mcp.json 解析失败: ${message}`);
    return { mcpServers: {} };
  }
}

function validateServerConfig(name: string, config: McpServerConfig): void {
  if (isStdioConfig(config)) {
    if (!config.command || typeof config.command !== "string") {
      throw new Error(`MCP server "${name}" 缺少 command 字段`);
    }
  } else {
    if (!config.url || typeof config.url !== "string") {
      throw new Error(`MCP server "${name}" 缺少 url 字段`);
    }
    if (config.type !== "sse" && config.type !== "streamableHttp") {
      throw new Error(`MCP server "${name}" 的 type 必须是 "sse" 或 "streamableHttp"`);
    }
  }
}

export { isStdioConfig };
