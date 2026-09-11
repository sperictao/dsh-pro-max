// 服务级自定义请求头编辑：键值行增删改 + 常用头预设 + JSON 粘贴导入。
// 凭据类保留头拒收（dsh Harness 归因头优先，配置它们既无效又误导）。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BTN_SM, INPUT, INPUT_MONO } from "@/shared/lib/ui";

const HEADER_PRESETS = [
  { name: "X-Title", value: "" },
  { name: "X-Client-Name", value: "dsh-pro-max" },
  { name: "User-Agent", value: "" },
];

/// dsh 侧凭据归因保留头：UI 直接拒收，提示走 apiKeyEnv
const RESERVED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "proxy-authorization",
]);

const headerIdentity = (name: string) => name.trim().toLowerCase();

export function isReservedHeader(name: string): boolean {
  return RESERVED_HEADERS.has(headerIdentity(name));
}

function upsertEntry(entries: [string, string][], name: string, value: string): [string, string][] {
  const identity = headerIdentity(name);
  const index = entries.findIndex(([key]) => headerIdentity(key) === identity);
  if (index < 0) return [...entries, [name, value]];
  return entries.map((entry, i) => (i === index ? [name, value] : entry));
}

export function HeadersEditor({
  headers,
  onChange,
}: {
  /** 绑定形态是 partial record（{ [key in string]?: string }），读取处按 null 归一 */
  headers: Record<string, string | undefined> | null;
  onChange: (next: Record<string, string> | null) => void;
}) {
  const { t } = useTranslation();
  // 编辑行是 UI 草稿，不等同于已经可落盘的 headers。尤其“Add header”必须先
  // 允许一个空白行存在，等用户填写名称后再归一到 ProviderConfig。
  const [entries, setEntriesState] = useState<[string, string][]>(() =>
    Object.entries(headers ?? {}).map(([key, value]) => [key, value ?? ""]),
  );
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonDraft, setJsonDraft] = useState("");
  const [jsonError, setJsonError] = useState(false);

  const reserved = entries.filter(([key]) => isReservedHeader(key)).map(([key]) => key);

  const commitEntries = (next: [string, string][]) => {
    setEntriesState(next);
    // HTTP header name identity is case-insensitive. Keep draft rows intact while typing, but
    // normalize the persisted map so case-only duplicates can never reach settings.yaml.
    // Later rows win, matching the editor's previous exact-key overwrite behavior.
    const normalized = new Map<string, { name: string; value: string }>();
    for (const [key, value] of next) {
      const name = key.trim();
      if (!name || isReservedHeader(name)) continue;
      normalized.set(headerIdentity(name), { name, value });
    }
    const map = Object.fromEntries(
      [...normalized.values()].map(({ name, value }) => [name, value]),
    );
    onChange(Object.keys(map).length > 0 ? map : null);
  };

  const updateAt = (index: number, key: string, value: string) => {
    const next = entries.map((entry, i) =>
      i === index ? ([key, value] as [string, string]) : entry,
    );
    commitEntries(next);
  };

  const removeAt = (index: number) => {
    commitEntries(entries.filter((_, i) => i !== index));
  };

  const applyJson = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonDraft);
    } catch {
      setJsonError(true);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setJsonError(true);
      return;
    }
    const imported = Object.entries(parsed as Record<string, unknown>);
    // JSON import is atomic: every property must be a named string header. Silently applying
    // only part of a pasted object makes the visible draft diverge from what the user supplied.
    if (imported.some(([key, value]) => !key.trim() || typeof value !== "string")) {
      setJsonError(true);
      return;
    }

    // Header identity is case-insensitive, so JSON/preset imports update an existing row rather
    // than creating a second case-variant row. Reserved rows remain visible long enough to show
    // the existing warning, while commitEntries still excludes them from persisted config.
    let merged = entries;
    for (const [key, value] of imported as [string, string][]) {
      merged = upsertEntry(merged, key.trim(), value);
    }
    commitEntries(merged);
    setJsonOpen(false);
    setJsonDraft("");
    setJsonError(false);
  };

  return (
    <div className="flex flex-col gap-2" data-testid="headers-editor">
      {reserved.length > 0 && (
        <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">
          {t("Reserved credential headers are ignored: {{names}}", { names: reserved.join(", ") })}
        </p>
      )}
      {entries.map(([key, value], i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            className={`${INPUT_MONO} w-48`}
            value={key}
            onChange={(event) => updateAt(i, event.target.value, value)}
            placeholder="X-Header"
            aria-label={t("Header name")}
          />
          <input
            className={`${INPUT_MONO} flex-1`}
            value={value}
            onChange={(event) => updateAt(i, key, event.target.value)}
            placeholder="value"
            aria-label={t("Header value")}
          />
          <button
            type="button"
            className={BTN_SM}
            onClick={() => removeAt(i)}
            aria-label={t("Remove header")}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BTN_SM}
          onClick={() => setEntriesState([...entries, ["", ""]])}
        >
          {t("Add header")}
        </button>
        <select
          className="h-6 rounded-md border border-input bg-background px-1 text-xs"
          value=""
          onChange={(event) => {
            const preset = HEADER_PRESETS.find((item) => item.name === event.target.value);
            if (preset) commitEntries(upsertEntry(entries, preset.name, preset.value));
          }}
          aria-label={t("Common headers")}
        >
          <option value="">{t("Common headers")}</option>
          {HEADER_PRESETS.map((preset) => (
            <option key={preset.name} value={preset.name}>
              {preset.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={BTN_SM}
          onClick={() => setJsonOpen((value) => !value)}
          aria-expanded={jsonOpen}
          aria-controls="provider-headers-json-import"
        >
          {t("Import JSON")}
        </button>
      </div>
      {jsonOpen && (
        <div id="provider-headers-json-import" className="flex flex-col gap-1">
          <textarea
            className={`${INPUT} h-20 py-2 font-mono text-xs`}
            value={jsonDraft}
            onChange={(event) => {
              setJsonDraft(event.target.value);
              setJsonError(false);
            }}
            placeholder='{"X-Title": "my-app"}'
            aria-label={t("Headers JSON")}
          />
          {jsonError && (
            <p role="alert" className="text-xs text-destructive">
              {t("Use a JSON object with header names and string values.")}
            </p>
          )}
          <button type="button" className={BTN_SM} onClick={applyJson}>
            {t("Apply")}
          </button>
        </div>
      )}
    </div>
  );
}
