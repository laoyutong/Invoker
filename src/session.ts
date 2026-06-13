import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelMessage } from "ai";

const SESSION_DIR = ".session";

// ============ 路径工具 ============

const sessionDir = (): string => path.join(process.cwd(), SESSION_DIR);

const sessionDirById = (id: string): string => path.join(sessionDir(), id);

const messagesPath = (id: string): string => path.join(sessionDirById(id), "messages.jsonl");

const indexPath = (): string => path.join(sessionDir(), "index.json");

const ensureDir = (dir: string): void => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

// ============ ID 生成 ============

const generateId = (): string => {
  const ts = Date.now().toString(36).slice(-4);
  const rand = Math.random().toString(16).slice(2, 4);
  return `${ts}${rand}`;
};

// ============ 索引管理 ============

interface SessionEntry {
  id: string;
  created: string;
}

const readIndex = (): SessionEntry[] => {
  const p = indexPath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as SessionEntry[];
  } catch {
    return [];
  }
};

const writeIndex = (entries: SessionEntry[]): void => {
  ensureDir(sessionDir());
  fs.writeFileSync(indexPath(), `${JSON.stringify(entries)}\n`, "utf-8");
};

const addToIndex = (id: string, created: string): void => {
  const entries = readIndex();
  // 去重：同 ID 只保留最新
  const filtered = entries.filter((e) => e.id !== id);
  filtered.push({ id, created });
  writeIndex(filtered);
};

const findLatest = (): SessionEntry | null => {
  const entries = readIndex();
  if (entries.length === 0) return null;
  return entries.reduce((latest, e) => (e.created > latest.created ? e : latest));
};

// ============ 当前 session 状态 ============

let currentId: string | null = null;
let currentCreated: string | null = null;

export const getSessionId = (): string => currentId ?? "unknown";

const requireSessionId = (): string => {
  if (!currentId) {
    throw new Error("Session 未初始化，请先调用 initSession()");
  }
  return currentId;
};

// ============ 公开 API ============

export interface InitOptions {
  /** 是否恢复已有 session */
  continueSession: boolean;
  /** 指定恢复的 session ID（不指定则用最新的） */
  targetId?: string;
}

/**
 * 初始化 session：
 * - targetId 明确 → 恢复指定 session
 * - continueSession 为 true 但没有 targetId → 恢复最新的
 * - continueSession 为 false → 新建
 */
export const initSession = (opts: InitOptions): void => {
  if (opts.targetId) {
    const entries = readIndex();
    const found = entries.find((e) => e.id === opts.targetId);
    if (found) {
      currentId = found.id;
      currentCreated = found.created;
      return;
    }
    console.log(`⚠️  未找到 session ${opts.targetId}，创建新会话`);
  }

  if (opts.continueSession) {
    const latest = findLatest();
    if (latest) {
      currentId = latest.id;
      currentCreated = latest.created;
      return;
    }
  }

  // 新建 session
  currentId = generateId();
  currentCreated = new Date().toISOString();
  ensureDir(sessionDirById(currentId));
  addToIndex(currentId, currentCreated);
};

/**
 * 加载当前 session 的消息历史
 */
export const loadSession = (): ModelMessage[] => {
  const filePath = messagesPath(requireSessionId());
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const messages: ModelMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as ModelMessage);
    } catch {
      console.warn(`⚠️  跳过无效的 session 行: ${trimmed.slice(0, 80)}...`);
    }
  }
  return messages;
};

/**
 * 覆写当前 session 的完整消息历史
 */
export const saveSession = (messages: ModelMessage[]): void => {
  const id = requireSessionId();
  ensureDir(sessionDirById(id));
  const lines = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
  fs.writeFileSync(messagesPath(id), lines, "utf-8");
};

/**
 * 当前 session 是否已有消息文件
 */
export const sessionExists = (): boolean => fs.existsSync(messagesPath(requireSessionId()));
