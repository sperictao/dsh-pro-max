#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const path = new URL("../src/features/models/ModelsView.tsx", import.meta.url);
let source = readFileSync(path, "utf8");
const beforeState = `                const armed = armedDelete === provider.route;\n                const testing = testingRoute === provider.route;\n                const rowBusy = busyRoute === provider.route || testing;`;
const afterState = `                const armed = armedDelete === provider.route;\n                const probing = busyRoute === provider.route;\n                const testing = testingRoute === provider.route;\n                const rowBusy = probing || testing;`;
if (!source.includes(afterState)) {
  if (!source.includes(beforeState)) throw new Error("row state target not found");
  source = source.replace(beforeState, afterState);
}
const beforeLabel = `{rowBusy ? t("Loading models…") : t("Fetch list")}`;
const afterLabel = `{probing ? t("Loading models…") : t("Fetch list")}`;
if (!source.includes(afterLabel)) {
  if (!source.includes(beforeLabel)) throw new Error("fetch label target not found");
  source = source.replace(beforeLabel, afterLabel);
}
writeFileSync(path, source);
console.log("✓ Step 5 row busy states isolated");
