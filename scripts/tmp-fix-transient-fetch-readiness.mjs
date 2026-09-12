import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

async function patch(path, replacements) {
  const full = join(root, path);
  let text = await readFile(full, "utf8");
  for (const [from, to, label] of replacements) {
    if (!text.includes(from)) throw new Error(`${path}: missing ${label}`);
    text = text.replace(from, to);
  }
  await writeFile(full, text);
}

await patch("src/features/models/ModelPanes.tsx", [
  [
    "  onModelsChange,\n  onFetch,\n}: {",
    "  onModelsChange,\n  onFetch,\n  canFetch,\n}: {",
    "canFetch destructuring",
  ],
  [
    "  onModelsChange: (models: ModelEntry[]) => void;\n  onFetch: () => void;\n}) {",
    "  onModelsChange: (models: ModelEntry[]) => void;\n  onFetch: () => void;\n  canFetch?: boolean;\n}) {",
    "canFetch prop type",
  ],
  [
    "  const connectionReadyForFetch =\n    Boolean(provider.baseURL?.trim()) &&\n    validateBaseUrl(provider.baseURL ?? \"\") == null &&\n    (!preset || Boolean(provider.apiKeyEnv?.trim()));",
    "  // ProviderDialog owns credential-aware discovery, including a transient write-only API key.\n  // Standalone callers keep the legacy provider-only readiness fallback.\n  const connectionReadyForFetch =\n    canFetch ??\n    (Boolean(provider.baseURL?.trim()) &&\n      validateBaseUrl(provider.baseURL ?? \"\") == null &&\n      (!preset || Boolean(provider.apiKeyEnv?.trim())));",
    "credential-aware fetch readiness",
  ],
]);

await patch("src/features/models/ProviderDialog.tsx", [
  [
    "                onModelsChange={setModels}\n                onFetch={discovery.reload}\n              />",
    "                onModelsChange={setModels}\n                onFetch={discovery.reload}\n                canFetch={discovery.canReload}\n              />",
    "pass discovery canReload",
  ],
]);

await patch("src/features/models/ProviderDialog.add.test.tsx", [
  [
    "    await waitFor(() =>\n      expect(within(models).getByRole(\"checkbox\", { name: /^deepseek-chat$/ })).toBeInTheDocument(),\n    );\n\n    await user.click(within(models).getByRole(\"checkbox\", { name: /^deepseek-v4-pro$/ }));",
    "    await waitFor(() =>\n      expect(within(models).getByRole(\"checkbox\", { name: /^deepseek-chat$/ })).toBeInTheDocument(),\n    );\n    await waitFor(() => expect(fetchList).toBeEnabled());\n\n    await user.click(within(models).getByRole(\"checkbox\", { name: /^deepseek-v4-pro$/ }));",
    "transient key fetch readiness regression assertion",
  ],
]);

await unlink(join(root, "scripts", "tmp-fix-transient-fetch-readiness.mjs"));
await unlink(join(root, ".github", "workflows", "tmp-fix-transient-fetch-readiness.yml"));
console.log("fixed transient credential Fetch list readiness and added regression coverage");
