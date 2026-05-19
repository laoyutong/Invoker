import { weatherTool, executeWeather } from "./weather";

export const toolRegistry: Record<
  string,
  { schema: typeof weatherTool; execute: (input: unknown) => unknown }
> = {
  weather: {
    schema: weatherTool,
    execute: (input) => executeWeather(input as { city: string }),
  },
};

export const tools = Object.fromEntries(
  Object.entries(toolRegistry).map(([name, entry]) => [name, entry.schema]),
);
