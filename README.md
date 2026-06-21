# Invoker

一个专注于编程领域的 CLI AI 助手。

## 架构

```
用户输入 → ToolSearch 激活延迟工具 → Prompt 模块化组装 → streamText (DeepSeek V4)
           ↕                                    ↕
      Session 持久化 (JSONL)              TokenTracker 校准 + 粗估
           ↕                                    ↕
      四级上下文保护流水线 ← 模型输出 + 工具调用执行
```

### Prompt 模块化

系统 prompt 通过 Pipe 架构组装，模块按序拼接：

| 模块 | 类型 | 说明 |
|------|------|------|
| `coreRules` | 静态 | 核心身份与对话风格 |
| `safetyRules` | 静态 | 安全约束 |
| `toolGuide` | 静态 | 工具使用指南 + 截断规则 |
| `codingConventions` | 静态 | 编码风格约定 |
| `deferredTools` | 动态 | 按上下文注入未激活的延迟工具摘要 |

## 已支持功能

### 对话与工具

- **流式对话** — REPL 交互，支持 reasoning / text / tool-call 多类型流式输出
- **工具调用** — `read_file` / `write_file` / `edit_file` / `find_files` / `fetch_url` / `glob` / `grep` / `bash`
- **MCP 扩展** — 支持连接外部 MCP Server，自动注册远端工具到调用循环
- **并发控制** — `isConcurrencySafe` 工具组内并行执行，不安全工具栅栏隔离
- **延迟加载** — `shouldDefer` 工具不在启动时注入，由 `ToolSearch` 按用户输入关键词自动激活
- **循环检测** — 滑动窗口检测对话死循环，警告 / 阻断两级

### Session 管理

- **持久化** — 对话以 JSON Lines 格式存储到磁盘，完整保留消息历史
- **恢复** — `--continue` 或 `-c` 恢复历史会话，支持指定 session ID
- **工具结果时间戳** — 每个 tool-call 记录创建时间，用于 TTL 修剪

### 四级上下文保护流水线

每次工具执行完毕后依次运行，防止上下文溢出：

| 层级 | 机制 | 触发条件 | 作用范围 |
|------|------|----------|----------|
| **第一级** | 单条动态截断 | 结果 chars > 窗口 50% | 当前工具结果 |
| **第二级** | 总量预算 | 全部结果 chars > 窗口 75% | 所有工具结果 |
| **第三级** | TTL 时间修剪 | 只读结果 > 5min / > 10min | 只读工具结果 |
| **第四级** | 查询类清理 | 只读结果数 > 10 个 | 只读工具结果 |

**最终防线** — 消息总数 > 40 条时，调用 LLM 将早期对话压缩为结构化摘要。

#### 第一级：单条动态截断

- 单条工具结果字符数不超过上下文窗口的 50%（基于 `CONTEXT_WINDOW.maxTokens × 4`）
- 超限做 Head/Tail 分割（头 60% + 尾 40%），并标记 `_truncated`
- 与工具自身 `maxResultChars` 取较小值

#### 第二级：总量预算

- 所有工具结果总字符数不超过窗口 75%
- 超限从最老的 tool result 开始替换为 `[tool result truncated]`
- 保留 assistant 消息中对应的 tool-call part，避免破坏 tool-call/tool-result 配对

#### 第三级：TTL 时间修剪

| 阶段 | 时间 | 行为 | 模型看到 |
|------|------|------|----------|
| 原始 | 0-5 min | 完整结果 | 正常内容 |
| 软修剪 | 5-10 min | 保留头尾各 1500 字符 | `头...[soft pruned: N chars]...尾` |
| 硬清除 | >10 min | 完全替换 tool result 内容 | `[tool result expired: tool_name]` |

- 仅对只读工具生效（`isReadOnly: true`）
- 含 error / fail / not found 等错误关键词的结果**自动跳过**，保留完整错误信息
- 已软修剪过的结果不会重复修剪
- 硬清除只替换 tool result 内容，保留对应 tool-call 以维持消息配对合法性

#### 第四级：查询类结果清理

- 只读工具结果超过 10 个时触发
- 保留最近 3 个，其余替换为 `[tool result cleared]`
- 保留 assistant 消息中对应的 tool-call，避免产生孤儿 tool result

#### 最终防线：LLM 结构化压缩

- 消息总数 > 40 条时触发
- 保留最近 15 条，早期对话送 LLM 生成结构化摘要
- 摘要模板：用户意图 / 工作计划 / 关键发现 / 已做决策 / 当前状态 / 关键上下文
- 支持增量压缩（将旧摘要合并到新摘要中）
- 切分点对齐 user 消息边界，不破坏 assistant(tool-call) + tool(result) 配对

### TokenTracker

- **精确校准** — 每次 API 调用返回后，用 `usage.inputTokens` 替换估算值作为基准
- **增量粗估** — 两次 API 调用间新增的消息用 `chars / 4` 估算 token 增量
- **output 累加** — 每次 API 调用的 `outputTokens` 累加
- **预算追踪** — 支持配置 `TOKEN_BUDGET.maxTokens` 上限，耗尽时自动终止

### 截断标记列表

模型可通过以下标记判断工具结果状态：

| 标记 | 含义 |
|------|------|
| `_truncated` | 单条结果超长，已做 Head/Tail 截断 |
| `[tool result truncated]` | 总量预算超限，结果被清理 |
| `[soft pruned: N chars]` | TTL 软修剪，中间内容已省略 |
| `[tool result expired: tool_name]` | TTL 硬清除，结果已过期 |
| `[tool result cleared]` | 查询类结果达到数量阈值被清理 |

### 其他

- **指数退避重试** — API 调用失败自动重试，禁用 SDK 内置重试
- **Terminal 友好** — 工具调用和执行结果带 emoji 前缀 + 结果截断显示
- **.env 配置** — 通过 `dotenv` 加载 `DEEPSEEK_API_KEY`
