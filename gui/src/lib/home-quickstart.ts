export type EndpointProtocol = "openai" | "anthropic";
export type QuickstartLang = "curl" | "python" | "ts";

export function buildQuickstartSnippet(protocol: EndpointProtocol, lang: QuickstartLang, endpoint: string): string {
  if (protocol === "anthropic") {
    if (lang === "python") {
      return `from anthropic import Anthropic\n\nclient = Anthropic(\n    base_url="${endpoint}",\n    api_key="YOUR_API_KEY",\n)\nres = client.messages.create(\n    model="claude-sonnet-4-6",\n    max_tokens=1024,\n    messages=[{"role": "user", "content": "Hello"}],\n)`;
    }
    if (lang === "ts") {
      return `import Anthropic from "@anthropic-ai/sdk";\n\nconst client = new Anthropic({\n  baseURL: "${endpoint}",\n  apiKey: "YOUR_API_KEY",\n});\nconst res = await client.messages.create({\n  model: "claude-sonnet-4-6",\n  max_tokens: 1024,\n  messages: [{ role: "user", content: "Hello" }],\n});`;
    }
    return `curl ${endpoint}/v1/messages \\\n  -H "x-api-key: YOUR_API_KEY" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'`;
  }
  if (lang === "python") {
    return `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${endpoint}",\n    api_key="YOUR_API_KEY",\n)\nres = client.chat.completions.create(\n    model="gpt-5.3-codex",\n    messages=[{"role": "user", "content": "Hello"}],\n)`;
  }
  if (lang === "ts") {
    return `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${endpoint}",\n  apiKey: "YOUR_API_KEY",\n});\nconst res = await client.chat.completions.create({\n  model: "gpt-5.3-codex",\n  messages: [{ role: "user", content: "Hello" }],\n});`;
  }
  return `curl ${endpoint}/chat/completions \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"gpt-5.3-codex","messages":[{"role":"user","content":"Hello"}]}'`;
}
