import fs from "node:fs";

const path = "e2e/smoke.mjs";
let text = fs.readFileSync(path, "utf8");

function replaceExact(before, after, label) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, got ${count}`);
  text = text.replace(before, after);
}

replaceExact(
  '        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),',
  '        model_credential_describe: ({ names }) => Object.fromEntries(\n          names.map((name) => [name, { configured: true, source: "file", writable: true }]),\n        ),\n        model_credential_set: () => ({ configured: true, source: "file", writable: true }),',
  "credential handlers",
);
replaceExact(
  '        model: "glm-5.2",\n      });',
  '        model: "glm-5.2",\n        apiKey: null,\n      });',
  "saved connection args",
);
replaceExact(
  '      await dialog.getByLabel("API Key Env Var").fill("E2E_API_KEY");',
  '      await dialog.getByLabel("API Key").fill("sk-e2e-test");',
  "custom api key input",
);
replaceExact(
  '      assert.equal(testCall.args.apiKeyEnv, "E2E_API_KEY");\n      assert.equal(testCall.args.model, "e2e-model-000");',
  '      assert.equal(testCall.args.apiKeyEnv, "E2E_GATEWAY_API_KEY");\n      assert.equal(testCall.args.apiKey, "sk-e2e-test");\n      assert.equal(testCall.args.model, "e2e-model-000");',
  "custom connection args",
);
replaceExact(
  '      assert.equal(added.apiKeyEnv, "E2E_API_KEY");',
  '      assert.equal(added.apiKeyEnv, "E2E_GATEWAY_API_KEY");\n      const credentialSet = (await commandCalls("model_credential_set")).at(-1);\n      assert.deepEqual(credentialSet.args, { name: "E2E_GATEWAY_API_KEY", value: "sk-e2e-test" });',
  "saved credential ref",
);
replaceExact(
  '        "model_env_status",',
  '        "model_credential_describe",\n        "model_credential_set",',
  "expected credential commands",
);

fs.writeFileSync(path, text);
