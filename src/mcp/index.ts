import { jsonSchema, tool } from "ai";

import type { ToolDefinition } from "../tools";
import { toolRegistry } from "../tools";
import { MCPClientManager } from "./client";
import type { McpServerConfig } from "./config";
import { loadConfig } from "./config";

const MCP_MAX_RESULT_CHARS = 10000;

/** 已连接的 MCP client manager，用于清理 */
const connectedClients: MCPClientManager[] = [];

/**
 * 将 MCP 工具名格式化为带 server 前缀的名称，避免与内置工具冲突
 */
function formatToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * 将 MCP 工具包装为 ToolDefinition，注册到全局 ToolRegistry
 */
function registerMCPTool(
  serverName: string,
  mcpTool: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  },
  client: MCPClientManager,
): void {
  const fullName = formatToolName(serverName, mcpTool.name);

  const schema = tool({
    description: mcpTool.description || `MCP tool: ${mcpTool.name} (server: ${serverName})`,
    inputSchema: jsonSchema(mcpTool.inputSchema),
  });

  const def = {
    name: fullName,
    description: mcpTool.description || `MCP tool ${mcpTool.name} from server ${serverName}`,
    parameters: mcpTool.inputSchema,
    execute: async (input: unknown) => {
      const result = await client.callTool(mcpTool.name, input as Record<string, unknown>);
      return result;
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    maxResultChars: MCP_MAX_RESULT_CHARS,
    schema,
  } satisfies ToolDefinition & { schema: unknown };

  toolRegistry.register(def);
}

/**
 * 连接到单个 MCP server 并注册其所有工具
 */
async function connectServer(serverName: string, config: McpServerConfig): Promise<void> {
  const client = new MCPClientManager(serverName, config);

  try {
    console.log(`🔌 正在连接 MCP server: ${serverName}...`);
    await client.connect();
    connectedClients.push(client);

    const tools = await client.listTools();
    console.log(`✅ MCP server "${serverName}" 已连接，${tools.length} 个工具`);

    for (const t of tools) {
      registerMCPTool(serverName, t, client);
      console.log(`   📌 注册工具: ${formatToolName(serverName, t.name)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ MCP server "${serverName}" 连接失败: ${message}`);
    // 连接失败时尝试清理
    try {
      await client.close();
    } catch {
      // 忽略清理错误
    }
  }
}

/**
 * 初始化 MCP：加载配置、连接所有 server、注册工具
 */
export async function initMCP(): Promise<void> {
  const config = loadConfig();
  const servers = Object.entries(config.mcpServers);

  if (servers.length === 0) {
    console.log("ℹ️ 未配置 MCP server（.mcp.json 不存在或为空），跳过 MCP 初始化");
    return;
  }

  console.log(`\n🔌 正在初始化 ${servers.length} 个 MCP server...`);

  // 串行连接，保证日志可读性
  for (const [name, serverConfig] of servers) {
    await connectServer(name, serverConfig);
  }

  console.log();
}

/**
 * 断开所有 MCP 连接
 */
export async function shutdownMCP(): Promise<void> {
  for (const client of connectedClients) {
    try {
      await client.close();
    } catch {
      // 忽略关闭错误
    }
  }
  connectedClients.length = 0;
}
