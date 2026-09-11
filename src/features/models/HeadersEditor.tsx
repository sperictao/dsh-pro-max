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

export function isReservedHeader(name: string): boolean {
  return RESERVED_HEADERS.has(name.trim().toLowerCase());
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
    // UI 可以保留未完成空白行；真正写回 ProviderConfig 时仍只接受有效普通头。
    const map: Record<string, string> = {};
    for (const [key, value] of next) {
      if (!key.trim() || isReservedHeader(key)) continue;
      map[key.trim()] = value;
    }
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
    // 同名键合并：JSON 值覆盖现有行；最终仍走 commitEntries，确保 JSON 导入
    // 与逐行编辑使用同一保留头过滤规则。
    const merged: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (key.trim()) merged[key] = value;
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") merged[key.trim()] = value;
    }
    commitEntries(Object.entries(merged));
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
            if (preset) commitEntries([...entries, [preset.name, preset.value]]);
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
        <button type="button" className={BTN_SM} onClick={() => setJsonOpen((value) => !value)}>
          {t("Import JSON")}
        </button>
      </div>
      {jsonOpen && (
        <div className="flex flex-col gap-1">
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
