export type ToolCallEntry = { toolCallId: string; toolName: string; input: unknown };

export type AssistantContentPart =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };

export type ToolResultPart = {
  type: "tool-result";
  toolCallId?: unknown;
  toolName?: unknown;
  output?: { value?: unknown };
};

export type ToolCallPart = {
  type: "tool-call";
  toolCallId?: unknown;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isToolResultPart = (part: unknown): part is ToolResultPart =>
  isRecord(part) && part.type === "tool-result";

export const isToolCallPart = (part: unknown): part is ToolCallPart =>
  isRecord(part) && part.type === "tool-call";
