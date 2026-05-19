import { tool, jsonSchema } from "ai";

const MOCK_WEATHER: Record<string, { temp: number; condition: string; humidity: number }> = {
  北京: { temp: 25, condition: "晴", humidity: 40 },
  上海: { temp: 28, condition: "多云", humidity: 65 },
  深圳: { temp: 30, condition: "阵雨", humidity: 80 },
  杭州: { temp: 26, condition: "阴", humidity: 70 },
  成都: { temp: 22, condition: "阴", humidity: 75 },
};

export const weatherTool = tool({
  description: "获取指定城市的天气信息，返回温度、天气状况和湿度",
  inputSchema: jsonSchema<{ city: string }>({
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称，如北京、上海、深圳等" },
    },
    required: ["city"],
  }),
});

export function executeWeather(input: { city: string }) {
  const data = MOCK_WEATHER[input.city];
  if (data) {
    return {
      city: input.city,
      temperature: data.temp,
      condition: data.condition,
      humidity: data.humidity,
    };
  }
  return {
    error: `未找到 ${input.city} 的天气数据`,
    available: Object.keys(MOCK_WEATHER).join("、"),
  };
}
