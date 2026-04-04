import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ensureModelAllowlistEntry } from "openclaw/plugin-sdk/provider-onboard";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//console.log("plugin file is running");
const AIOS_URL = "http://localhost:8000";

export default definePluginEntry({
  id: "aios",
  name: "AIOS Kernel",
  description: "Routes LLM calls through the AIOS scheduler",

  register(api) {
api.on("gateway_start", async () => {
  //console.log("AIOS gateway start hook fired");
  try {
    const res = await fetch(`${AIOS_URL}/core/llms/list`);
    const data = await res.json();
    const llms: { name: string }[] = data?.llms ?? [];
    if (llms.length === 0) return;

    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    let cfg = JSON.parse(raw);

    for (const llm of llms) {
      const modelRef = `aios/${llm.name}`;
      if (!cfg.agents?.defaults?.models?.[modelRef]) {
        cfg = ensureModelAllowlistEntry({ cfg, modelRef });
      }
    }

    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
  } catch (err) {
    api.logger.warn(`[aios] Could not auto-add models to allowlist: ${String(err)}`);
  }
});
    api.registerProvider({
      id: "aios",
      label: "AIOS",
      auth: [],
resolveSyntheticAuth: () => ({
  apiKey: "dummy",
  source: "aios-plugin",
  mode: "api_key" as const,
}),

      catalog: {
        order: "simple",
        run: async (ctx) => {
  const apiKey = ctx.resolveProviderApiKey("aios").apiKey;

  let llms: { name: string; backend: string }[] = [];
  try {
    const res = await fetch(`${AIOS_URL}/core/llms/list`);
    const data = await res.json();
    llms = data?.llms ?? [];
  } catch {
    llms = [];
  }

  const models = llms.map((llm) => ({
    id: llm.name,
    name: `${llm.name} (via AIOS)`,
    reasoning: false,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8096,
  }));

  return {
    provider: {
      baseUrl: AIOS_URL,
      apiKey,
      api: "openai-completions",
      models,
    },
  };
},
      },

      resolveDynamicModel: (ctx) => ({
        id: ctx.modelId,
        name: ctx.modelId,
        provider: "aios",
        api: "openai-completions",
        baseUrl: AIOS_URL,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8096,
      }),

      createStreamFn: (ctx) => {
        //console.log("[AIOS] createStreamFn called", ctx.model?.baseUrl, ctx.model?.api);

        return (model, context, options) => {
          const { AssistantMessageEventStream } = require("@mariozechner/pi-ai");
          const stream = new AssistantMessageEventStream();

          (async () => {
            const output = {
              role: "assistant" as const,
              content: [] as { type: "text"; text: string }[],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop" as const,
              timestamp: Date.now(),
            };

            try {
              stream.push({ type: "start", partial: output });

              const messages: { role: string; content: string }[] = [];

              if (context.systemPrompt) {
                messages.push({ role: "system", content: context.systemPrompt });
              }

              for (const msg of context.messages) {
  if (msg.role === "user") {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("");
    messages.push({ role: "user", content });
  } else if (msg.role === "assistant") {
    const textContent = msg.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const toolCallContent = msg.content
      .filter((b: any) => b.type === "toolCall")
      .map((b: any) => `<function_calls><invoke name="${b.name}">${Object.entries(b.arguments ?? {}).map(([k, v]) => `<parameter name="${k}">${v}</parameter>`).join("")}</invoke></function_calls>`)
      .join("");
    messages.push({ role: "assistant", content: textContent + toolCallContent || "" });
  } else if (msg.role === "toolResult") {
    const content = msg.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    messages.push({
      role: "user",
      content: `Tool result for ${msg.toolName}: ${content}`,
    });
  }
}
const llmsRes = await fetch(`${AIOS_URL}/core/llms/list`);
const llmsData = await llmsRes.json();
const llmInfo = (llmsData?.llms ?? []).find((l: any) => l.name === model.id);
const backend = llmInfo?.backend ?? "anthropic";
//console.log("[AIOS] sending messages:", JSON.stringify(messages, null, 2));
              let data: any;
let retries = 0;
while (true) {
  const response = await fetch(`${AIOS_URL}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_name: "openclaw",
      query_type: "llm",
      query_data: {
        messages,
        llms: [{ name: model.id, backend }],
        action_type: "chat",
        message_return_type: "text",
      },
    }),
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(`AIOS error: ${response.status} ${response.statusText}`);
  }

  data = await response.json();

  if (data?.response?.status_code === 429) {
    if (retries >= 3) {
      throw new Error("Rate limit exceeded after 3 retries.");
    }
    retries++;
    await new Promise((resolve) => setTimeout(resolve, 20000));
    continue;
  }

  break;
}
//console.log("[AIOS] full response:", JSON.stringify(data, null, 2));
              const text = data?.response?.response_message ?? "";
//console.log("[AIOS] raw response_message:", data?.response?.response_message);


              const toolCallMatch = text.match(/<function_calls>([\s\S]*?)<\/function_calls>/);
if (toolCallMatch) {
  const invokeRegex = /<invoke name="([^"]+)"(?:\s*\/>|>([\s\S]*?)<\/invoke>)/g;
  let invokeMatch;
  while ((invokeMatch = invokeRegex.exec(toolCallMatch[1])) !== null) {
    const toolName = invokeMatch[1];
    const paramsXml = invokeMatch[2] ?? "";
    const toolArgs: Record<string, string> = {};
    const paramRegex = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsXml)) !== null) {
      toolArgs[paramMatch[1]] = paramMatch[2];
    }
    const block = {
      type: "toolCall" as const,
      id: `tool_${Date.now()}`,
      name: toolName,
      arguments: toolArgs,
    };
    output.content.push(block as any);
    const idx = output.content.length - 1;
    stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
    stream.push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(toolArgs), partial: output });
    stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
  }
  output.stopReason = "toolUse" as const;
  stream.push({ type: "done", reason: "toolUse" as const, message: output });
  stream.end();
  return;

}

const textBlock = { type: "text" as const, text };
output.content.push(textBlock);
stream.push({ type: "text_start", contentIndex: 0, partial: output });
stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
stream.push({ type: "done", reason: "stop" as const, message: output });
stream.end();
            } catch (error) {
              (output as any).stopReason = "error";
              (output as any).errorMessage =
                error instanceof Error ? error.message : String(error);
              stream.push({ type: "error", reason: "error" as const, error: output as any });
              stream.end();
            }
          })();

          return stream;
        };
      },
    });
  },
});