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
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonDraft, setJsonDraft] = useState("");
  const [jsonError, setJsonError] = useState(false);

  // partial record → 纯 [key, value] 行；缺值按空串（写入时仍会归一）
  const entries: [string, string][] = Object.entries(headers ?? {}).map(
    ([k, v]) => [k, v ?? ""],
  );
  const reserved = entries.filter(([k]) => isReservedHeader(k)).map(([k]) => k);

  const setEntries = (next: [string, string][]) => {
    // 凭据类保留头拒收：不写入落盘（保留头归 dsh Harness / apiKeyEnv 管）
    const map: Record<string, string> = {};
    for (const [k, v] of next) {
      if (!k.trim() || isReservedHeader(k)) continue;
      map[k.trim()] = v;
    }
    onChange(Object.keys(map).length > 0 ? map : null);
  };

  const updateAt = (index: number, key: string, value: string) => {
    const next = entries.map((e, i) => (i === index ? ([key, value] as [string, string]) : e));
    setEntries(next);
  };

  const removeAt = (index: number) => {
    setEntries(entries.filter((_, i) => i !== index));
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
    // 同名键合并：JSON 值覆盖现有行
    const merged: Record<string, string> = {};
    for (const [k, v] of entries) merged[k] = v;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") merged[k.trim()] = v;
    }
    onChange(merged);
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
        <div key={`${key}-${i}`} className="flex items-center gap-2">
          <input
            className={`${INPUT_MONO} w-48`}
            value={key}
            onChange={(e) => updateAt(i, e.target.value, value)}
            placeholder="X-Header"
            aria-label={t("Header name")}
          />
          <input
            className={`${INPUT_MONO} flex-1`}
            value={value}
            onChange={(e) => updateAt(i, key, e.target.value)}
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
        <button type="button" className={BTN_SM} onClick={() => setEntries([...entries, ["", ""]])}>
          {t("Add header")}
        </button>
        <select
          className="h-6 rounded-md border border-input bg-background px-1 text-xs"
          value=""
          onChange={(e) => {
            const preset = HEADER_PRESETS.find((p) => p.name === e.target.value);
            if (preset) setEntries([...entries, [preset.name, preset.value]]);
          }}
          aria-label={t("Common headers")}
        >
          <option value="">{t("Common headers")}</option>
          {HEADER_PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="button" className={BTN_SM} onClick={() => setJsonOpen((v) => !v)}>
          {t("Import JSON")}
        </button>
      </div>
      {jsonOpen && (
        <div className="flex flex-col gap-1">
          <textarea
            className={`${INPUT} h-20 py-2 font-mono text-xs`}
            value={jsonDraft}
            onChange={(e) => {
              setJsonDraft(e.target.value);
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
