import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { McpServerConfig } from "./config";
import { isStdioConfig } from "./config";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export class MCPClientManager {
  private client: Client;
  private serverName: string;
  private config: McpServerConfig;
  private connected = false;

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
    this.client = new Client({
      name: "Invoker",
      version: "1.0.0",
    });
  }

  async connect(): Promise<void> {
    const transport = isStdioConfig(this.config)
      ? new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: (this.config.env ? { ...process.env, ...this.config.env } : process.env) as Record<
            string,
            string
          >,
          cwd: this.config.cwd,
        })
      : this.config.type === "sse"
        ? new SSEClientTransport(new URL(this.config.url), {
            requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
          })
        : new StreamableHTTPClientTransport(new URL(this.config.url), {
            requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
          });

    await this.client.connect(transport);
    this.connected = true;
  }

  async listTools(): Promise<
    { name: string; description?: string; inputSchema: Record<string, unknown> }[]
  > {
    if (!this.connected) {
      throw new Error(`MCP server "${this.serverName}" not connected`);
    }
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      throw new Error(`MCP server "${this.serverName}" not connected`);
    }
    const result = await this.client.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const textParts = content
      .filter((c): c is { type: "text"; text: string } => isRecord(c) && c.type === "text")
      .map((c) => c.text)
      .filter((t): t is string => t !== undefined);
    const text = textParts.join("\n");
    const structuredContent = isRecord(result) ? result.structuredContent : undefined;

    if (result.isError) {
      return {
        error: "MCP tool returned error",
        text,
        content,
        structuredContent,
      };
    }

    if (content.length === textParts.length && structuredContent === undefined) {
      return text;
    }

    return {
      text,
      content,
      structuredContent,
    };
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}
