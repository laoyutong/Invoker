import * as childProcess from "node:child_process";
import * as os from "node:os";
import { jsonSchema, tool } from "ai";
import { resolveWorkspacePath } from "../path-utils";
import type { ToolDefinition } from "./index";

const DEFAULT_TIMEOUT = 120_000; // 2 分钟
const MAX_TIMEOUT = 600_000; // 10 分钟
const MAX_BUFFER = 1024 * 1024; // 1MB

export const bashTool = tool({
  description:
    "执行 shell 命令并返回 stdout、stderr 和退出码。" +
    "支持超时控制、后台运行、环境信息检测。" +
    "适用于构建、测试、git 操作等场景。",
  inputSchema: jsonSchema<{
    command: string;
    description: string;
    workdir?: string;
    timeout?: number;
    run_in_background?: boolean;
  }>({
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "要执行的 shell 命令",
      },
      description: {
        type: "string",
        description: "命令用途的简短说明，帮助理解执行目的",
      },
      workdir: {
        type: "string",
        description: "执行命令的工作目录（相对于工作目录），默认为工作目录根",
      },
      timeout: {
        type: "number",
        description: `超时时间（毫秒），默认 ${DEFAULT_TIMEOUT}ms，最大 ${MAX_TIMEOUT}ms`,
      },
      run_in_background: {
        type: "boolean",
        description: "设为 true 时在后台运行，立即返回。默认 false",
      },
    },
    required: ["command", "description"],
  }),
});

function getEnvironmentInfo() {
  return {
    os: `${os.platform()} ${os.release()}`,
    shell: process.env.SHELL || process.env.COMSPEC || "unknown",
    nodeVersion: process.version,
    workdir: process.cwd(),
    home: os.homedir(),
  };
}

export async function executeBash(input: {
  command: string;
  description: string;
  workdir?: string;
  timeout?: number;
  run_in_background?: boolean;
}) {
  const env = getEnvironmentInfo();

  const cwd = resolveWorkspacePath(input.workdir || ".");
  if (!cwd.ok) {
    return { error: `不允许在工作目录之外执行命令: ${cwd.error}`, env };
  }

  const timeout = Math.min(MAX_TIMEOUT, Math.max(1, input.timeout ?? DEFAULT_TIMEOUT));

  if (input.run_in_background) {
    const child = childProcess.exec(input.command, {
      cwd: cwd.path,
      shell: env.shell || "/bin/sh",
      env: { ...process.env },
      maxBuffer: MAX_BUFFER,
    });

    child.on("error", () => {}); // 忽略错误，后台进程

    return {
      status: "started",
      pid: child.pid,
      description: input.description,
      env,
    };
  }

  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = childProcess.exec(input.command, {
      cwd: cwd.path,
      shell: env.shell || "/bin/sh",
      env: { ...process.env },
      maxBuffer: MAX_BUFFER,
      timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("close", (code, signal) => {
      const duration = Date.now() - startTime;
      resolve({
        stdout: stdout.slice(0, MAX_BUFFER),
        stderr: stderr.slice(0, MAX_BUFFER),
        exitCode: code,
        signal: signal || undefined,
        killed: signal === "SIGTERM" && code === null,
        duration,
        env,
      });
    });

    child.on("error", (err) => {
      const duration = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        stdout: stdout.slice(0, MAX_BUFFER),
        stderr: (stderr + (stderr ? "\n" : "") + message).slice(0, MAX_BUFFER),
        exitCode: null,
        killed: false,
        duration,
        env,
      });
    });
  });
}

export const bashConfig = {
  name: "bash",
  description:
    "执行 shell 命令并返回 stdout、stderr 和退出码。" +
    "支持超时控制（默认 2 分钟，最大 10 分钟）、后台运行。" +
    "返回结果中含环境信息（OS、Shell、Node 版本等）。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
      description: { type: "string", description: "命令用途的简短说明" },
      workdir: { type: "string", description: "工作目录（相对于工作目录），默认为工作目录根" },
      timeout: { type: "number", description: `超时时间（毫秒），默认 ${DEFAULT_TIMEOUT}ms` },
      run_in_background: { type: "boolean", description: "后台运行" },
    },
    required: ["command", "description"],
  },
  execute: (input: unknown) =>
    executeBash(
      input as {
        command: string;
        description: string;
        workdir?: string;
        timeout?: number;
        run_in_background?: boolean;
      },
    ),
  isReadOnly: false,
  isConcurrencySafe: false,
  maxResultChars: 10000,
  schema: bashTool,
} satisfies ToolDefinition & { schema: unknown };
