// 本文件由 scripts/generate-model-presets.mjs 生成（@earendil-works/pi-ai@0.85.1）。
// 单一事实来源是 pi-ai 内置 provider 目录：手改即破，升级后重跑 pnpm gen:model-presets。

export type ModelPreset = {
  /** pi-ai 内置目录的路由键：命中时 dsh 继承目录端点/协议/模型目录 */
  id: string;
  name: string;
  baseUrl: string;
  /** UI 三协议之一；null = 不预填（继承目录协议） */
  api: string | null;
  /** 目录模型数量（选择器副行展示） */
  models: number;
};

export const MODEL_PRESETS: ModelPreset[] = [
  {
    "id": "ant-ling",
    "name": "Ant Ling",
    "baseUrl": "https://api.ant-ling.com/v1",
    "api": "openai-completions",
    "models": 3
  },
  {
    "id": "anthropic",
    "name": "Anthropic",
    "baseUrl": "https://api.anthropic.com",
    "api": "anthropic-messages",
    "models": 14
  },
  {
    "id": "baseten",
    "name": "Baseten",
    "baseUrl": "https://inference.baseten.co/v1",
    "api": "openai-completions",
    "models": 20
  },
  {
    "id": "cerebras",
    "name": "Cerebras",
    "baseUrl": "https://api.cerebras.ai/v1",
    "api": "openai-completions",
    "models": 2
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "baseUrl": "https://api.deepseek.com",
    "api": "openai-completions",
    "models": 3
  },
  {
    "id": "fireworks",
    "name": "Fireworks",
    "baseUrl": "https://api.fireworks.ai/inference",
    "api": "anthropic-messages",
    "models": 20
  },
  {
    "id": "github-copilot",
    "name": "GitHub Copilot",
    "baseUrl": "https://api.individual.githubcopilot.com",
    "api": "openai-responses",
    "models": 28
  },
  {
    "id": "google",
    "name": "Google",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "api": null,
    "models": 22
  },
  {
    "id": "groq",
    "name": "Groq",
    "baseUrl": "https://api.groq.com/openai/v1",
    "api": "openai-completions",
    "models": 7
  },
  {
    "id": "huggingface",
    "name": "Hugging Face",
    "baseUrl": "https://router.huggingface.co/v1",
    "api": "openai-completions",
    "models": 71
  },
  {
    "id": "kimi-coding",
    "name": "Kimi For Coding",
    "baseUrl": "https://api.kimi.com/coding",
    "api": "anthropic-messages",
    "models": 4
  },
  {
    "id": "minimax",
    "name": "MiniMax",
    "baseUrl": "https://api.minimax.io/anthropic",
    "api": "anthropic-messages",
    "models": 3
  },
  {
    "id": "minimax-cn",
    "name": "MiniMax CN",
    "baseUrl": "https://api.minimaxi.com/anthropic",
    "api": "anthropic-messages",
    "models": 3
  },
  {
    "id": "mistral",
    "name": "Mistral",
    "baseUrl": "https://api.mistral.ai",
    "api": null,
    "models": 32
  },
  {
    "id": "moonshotai",
    "name": "Moonshot AI",
    "baseUrl": "https://api.moonshot.ai/v1",
    "api": "openai-completions",
    "models": 10
  },
  {
    "id": "moonshotai-cn",
    "name": "Moonshot AI CN",
    "baseUrl": "https://api.moonshot.cn/v1",
    "api": "openai-completions",
    "models": 10
  },
  {
    "id": "nvidia",
    "name": "NVIDIA",
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "api": "openai-completions",
    "models": 20
  },
  {
    "id": "openai",
    "name": "OpenAI",
    "baseUrl": "https://api.openai.com/v1",
    "api": "openai-responses",
    "models": 39
  },
  {
    "id": "openai-codex",
    "name": "OpenAI Codex",
    "baseUrl": "https://chatgpt.com/backend-api",
    "api": null,
    "models": 8
  },
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "api": "openai-completions",
    "models": 366
  },
  {
    "id": "qwen-token-plan",
    "name": "Qwen Token Plan",
    "baseUrl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "api": "openai-completions",
    "models": 18
  },
  {
    "id": "qwen-token-plan-cn",
    "name": "Qwen Token Plan CN",
    "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "api": "openai-completions",
    "models": 18
  },
  {
    "id": "qwen-token-plan-individual",
    "name": "Qwen Token Plan Individual",
    "baseUrl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "api": "openai-completions",
    "models": 9
  },
  {
    "id": "together",
    "name": "Together",
    "baseUrl": "https://api.together.ai/v1",
    "api": "openai-completions",
    "models": 21
  },
  {
    "id": "vercel-ai-gateway",
    "name": "Vercel AI Gateway",
    "baseUrl": "https://ai-gateway.vercel.sh",
    "api": "anthropic-messages",
    "models": 237
  },
  {
    "id": "xai",
    "name": "xAI",
    "baseUrl": "https://api.x.ai/v1",
    "api": "openai-responses",
    "models": 3
  },
  {
    "id": "xiaomi",
    "name": "Xiaomi",
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "api": "openai-completions",
    "models": 3
  },
  {
    "id": "xiaomi-token-plan-ams",
    "name": "Xiaomi Token Plan AMS",
    "baseUrl": "https://token-plan-ams.xiaomimimo.com/v1",
    "api": "openai-completions",
    "models": 2
  },
  {
    "id": "xiaomi-token-plan-cn",
    "name": "Xiaomi Token Plan CN",
    "baseUrl": "https://token-plan-cn.xiaomimimo.com/v1",
    "api": "openai-completions",
    "models": 2
  },
  {
    "id": "xiaomi-token-plan-sgp",
    "name": "Xiaomi Token Plan SGP",
    "baseUrl": "https://token-plan-sgp.xiaomimimo.com/v1",
    "api": "openai-completions",
    "models": 2
  },
  {
    "id": "zai",
    "name": "Z.AI",
    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
    "api": "openai-completions",
    "models": 7
  },
  {
    "id": "zai-coding-cn",
    "name": "Z.AI Coding CN",
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
    "api": "openai-completions",
    "models": 10
  }
];
