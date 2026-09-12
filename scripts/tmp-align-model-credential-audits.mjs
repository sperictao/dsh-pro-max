import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const e2eDir = join(root, "e2e");
const targetFiles = new Set([
  "capture-models-custom-endpoint.mjs",
  "capture-models-provider-card-test-connection.mjs",
  "capture-models-test-connection.mjs",
  "capture-models-default-model.mjs",
  "capture-models-add-provider.mjs",
  "capture-models-provider-card-fetch-list.mjs",
  "capture-models-edit-provider.mjs",
  "capture-models-advanced-settings.mjs",
  "capture-models-test-connection-retry.mjs",
  "capture-models-service-picker.mjs",
  "capture-models-fetch-list.mjs",
]);

function replaceRequired(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`missing expected audit pattern: ${label}`);
  return text.replace(from, to);
}

const files = (await readdir(e2eDir)).filter((name) => targetFiles.has(name));
if (files.length !== targetFiles.size) {
  const missing = [...targetFiles].filter((name) => !files.includes(name));
  throw new Error(`missing target audit files: ${missing.join(", ")}`);
}

let changedFiles = 0;
for (const name of files) {
  const path = join(e2eDir, name);
  const original = await readFile(path, "utf8");
  let text = original.replaceAll("API Key Env Var", "API Key");

  text = text.replace(
    /^(\s*)model_env_status: \(\{ names \}\) => Object\.fromEntries\(names\.map\(\(name\) => \[name, true\]\)\),$/gm,
    '$1model_credential_describe: ({ names }) => Object.fromEntries(names.map((name) => [name, { configured: true, source: "file", writable: true }])),',
  );

  if (text.includes("model_credential_describe:") && !text.includes("model_credential_set:")) {
    text = text.replace(
      /^(\s*)(model_credential_describe: .*\n)/m,
      '$1$2$1model_credential_set: () => ({ configured: true, source: "file", writable: true }),\n$1model_credential_unset: () => ({ configured: false, source: null, writable: true }),\n',
    );
  }

  if (name === "capture-models-custom-endpoint.mjs") {
    text = replaceRequired(
      text,
      'assert.equal(added.apiKeyEnv, "ACME_API_KEY");',
      'assert.equal(added.apiKeyEnv, "ACME_GATEWAY_API_KEY");',
      `${name}: derived custom credential ref`,
    );
  }

  if (name === "capture-models-test-connection.mjs") {
    text = replaceRequired(
      text,
      'apiKeyEnv: "ACME_GATEWAY_API_KEY",',
      'apiKeyEnv: null,',
      `${name}: transient key keeps ref null before save`,
    );
  }

  if (name === "capture-models-edit-provider.mjs") {
    text = replaceRequired(
      text,
      'const apiKeyEnv = dialog.getByRole("textbox", { name: "API Key" });',
      'const apiKey = dialog.getByLabel("API Key");',
      `${name}: password input locator`,
    );
    text = replaceRequired(
      text,
      'assert.equal(await apiKeyEnv.inputValue(), "DEEPSEEK_API_KEY");',
      'assert.equal(await apiKey.inputValue(), "", "existing secrets must stay write-only");',
      `${name}: write-only edit key`,
    );
    text = replaceRequired(
      text,
      'await apiKeyEnv.fill("DEEPSEEK_PROD_API_KEY");',
      'await apiKey.fill("sk-deepseek-prod");',
      `${name}: replacement secret`,
    );
    text = replaceRequired(
      text,
      'assert.equal(edited.apiKeyEnv, "DEEPSEEK_PROD_API_KEY");',
      'assert.equal(edited.apiKeyEnv, "DEEPSEEK_API_KEY");',
      `${name}: stable credential ref`,
    );
  }

  if (name === "capture-models-test-connection-retry.mjs") {
    text = replaceRequired(
      text,
      'const apiKey = dialog.getByRole("textbox", { name: "API Key" });',
      'const apiKey = dialog.getByLabel("API Key");',
      `${name}: password input locator`,
    );
    text = replaceRequired(
      text,
      'await apiKey.fill("DEEPSEEK_ROTATED_KEY");',
      'await apiKey.fill("sk-deepseek-rotated");',
      `${name}: transient repaired secret`,
    );
    text = replaceRequired(
      text,
      'assert.equal(calls[1].apiKeyEnv, "DEEPSEEK_ROTATED_KEY");',
      'assert.equal(calls[1].apiKeyEnv, "DEEPSEEK_API_KEY");\n    assert.equal(calls[0].apiKey, null);\n    assert.equal(calls[1].apiKey, "sk-deepseek-rotated");',
      `${name}: transient retry args`,
    );
  }

  if (text !== original) {
    await writeFile(path, text);
    changedFiles += 1;
  }
}

if (changedFiles < 8) throw new Error(`expected broad audit migration, changed only ${changedFiles} files`);

await unlink(join(root, "scripts", "tmp-align-model-credential-audits.mjs"));
await unlink(join(root, ".github", "workflows", "tmp-align-model-credential-audits.yml"));
console.log(`aligned ${changedFiles} Models audit capture scripts with credential cutover`);
