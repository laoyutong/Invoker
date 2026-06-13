import type { ModelMessage } from "ai";

import { CONTEXT_WINDOW, TOOL_RESULT_BUDGET } from "./constants";
import type { ToolCallEntry } from "./message-parts";
import { logToolResult, truncateResult } from "./tool-results";
import { type ToolDefinition, toolRegistry } from "./tools";

type ToolExecution = {
  tc: ToolCallEntry;
  entry: ToolDefinition;
};

type PushMessage = (msg: ModelMessage) => void;

const executeOne = async (tc: ToolCallEntry, entry: ToolDefinition) => {
  const rawResult = await entry.execute(tc.input);

  const maxSingleChars = Math.floor(
    CONTEXT_WINDOW.maxTokens * 4 * TOOL_RESULT_BUDGET.maxSingleResultRatio,
  );
  const effectiveMaxChars = entry.maxResultChars
    ? Math.min(entry.maxResultChars, maxSingleChars)
    : maxSingleChars;

  let result: unknown = rawResult;
  if (JSON.stringify(rawResult).length > effectiveMaxChars) {
    const { truncated, text, skipped } = truncateResult(rawResult, effectiveMaxChars);
    if (truncated) {
      result = { _truncated: true, _skipped: skipped, content: text };
    }
  }

  return { tc, result, rawResult, entry };
};

const groupToolCalls = (entries: ToolExecution[]): ToolExecution[][] => {
  const groups: ToolExecution[][] = [];
  let current: ToolExecution[] = [];

  for (const e of entries) {
    if (e.entry.isConcurrencySafe) {
      current.push(e);
    } else {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      groups.push([e]);
    }
  }

  if (current.length > 0) groups.push(current);
  return groups;
};

const pushToolResult = (pushMessage: PushMessage, tc: ToolCallEntry, result: unknown): void => {
  pushMessage({
    role: "tool",
    content: [
      {
        type: "tool-result" as const,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: { type: "json" as const, value: result },
      },
    ],
  } as ModelMessage);
};

export const executeToolCalls = async (
  toolCalls: ToolCallEntry[],
  pushMessage: PushMessage,
): Promise<void> => {
  const entries: ToolExecution[] = [];
  for (const tc of toolCalls) {
    const entry = toolRegistry.lookup(tc.toolName);
    if (entry) entries.push({ tc, entry });
  }

  const groups = groupToolCalls(entries);

  for (const group of groups) {
    if (group.length === 1 && !group[0].entry.isConcurrencySafe) {
      const { tc, entry } = group[0];
      const { result, rawResult } = await executeOne(tc, entry);
      logToolResult(tc.toolName, rawResult, entry.maxResultChars);
      pushToolResult(pushMessage, tc, result);
      continue;
    }

    const results = await Promise.all(group.map((e) => executeOne(e.tc, e.entry)));
    for (const { tc, rawResult, entry } of results) {
      logToolResult(tc.toolName, rawResult, entry.maxResultChars);
    }
    for (const { tc, result } of results) {
      pushToolResult(pushMessage, tc, result);
    }
  }
};
