import type { Tool } from "ai";
import { weatherTool, executeWeather } from "./weather";
import { taskStatusTool, executeTaskStatus } from "./trap";

export const toolRegistry: Record<
  string,
  { schema: Tool; execute: (input: unknown) => unknown }
> = {
  weather: {
    schema: weatherTool,
    execute: (input) => executeWeather(input as { city: string }),
  },
  task_status: {
    schema: taskStatusTool,
    execute: (input) => executeTaskStatus(input as { taskId: string }),
  },
};

export const tools = Object.fromEntries(
  Object.entries(toolRegistry).map(([name, entry]) => [name, entry.schema]),
);
