// 配置导入对话框：扫描本机其他工具的 provider 声明，按来源分组勾选后导入。
// 来源为明文密钥的条目只计数提示（值不读取、不落盘）。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BTN, BTN_PRIMARY, BTN_SM, INPUT } from "@/shared/lib/ui";
import * as cmd from "@/shared/commands";
import type { ImportGroup, ImportRunResult } from "@/shared/types";
import { tErr } from "@/shared/i18n/error";

export function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (result: ImportRunResult) => void;
}) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<ImportGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const result = await cmd.modelConfigImportScan();
        if (!disposed) {
          setGroups(result);
          // 安全默认值：可直接复用的 env/无凭据条目自动勾选；来源持明文 key 的
          // 条目必须由用户显式选择，避免一键导入后得到“看似成功、实际缺凭据”的 provider。
          setSelected(
            new Set(
              result.flatMap((group) =>
                group.entries
                  .filter((entry) => entry.credential !== "literal")
                  .map((entry) => entry.key),
              ),
            ),
          );
        }
      } catch (e) {
        if (!disposed) setError(tErr(String(e)));
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleGroup = (group: ImportGroup) => {
    const keys = group.entries.map((e) => e.key);
    const allSelected = keys.every((k) => selected.has(k));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (allSelected) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  };

  const run = async () => {
    setRunning(true);
    try {
      const result = await cmd.modelConfigImportRun([...selected]);
      // 成功提示由父视图 toast（含导入计数），此处直接关闭
      onImported(result);
      onClose();
    } catch (e) {
      setError(tErr(String(e)));
      setRunning(false);
    }
  };

  const q = query.trim().toLowerCase();
  const visible = (groups ?? []).map((g) => ({
    ...g,
    entries: q
      ? g.entries.filter(
          (e) =>
            e.route.toLowerCase().includes(q) ||
            e.name.toLowerCase().includes(q) ||
            (e.baseURL ?? "").toLowerCase().includes(q),
        )
      : g.entries,
  }));
  // 空来源是扫描实现细节，不占用结果区；搜索后也只保留真正命中的来源。
  const visibleGroups = visible.filter((group) => group.entries.length > 0);
  const totalFound = (groups ?? []).reduce((n, g) => n + g.entries.length, 0);
  const visibleFound = visibleGroups.reduce((n, g) => n + g.entries.length, 0);
  const literalCount = [...selected].length > 0 ? countLiteral(groups ?? [], selected) : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t("Import provider configuration")}
      id="import-dialog"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !running) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-lg">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t("Import provider configuration")}</h3>
          <button type="button" className={BTN_SM} onClick={onClose} aria-label={t("Close")}>
            ✕
          </button>
        </div>
        <p className="text-xs opacity-60">
          {t(
            "Scan local agent tools (Claude Code, Codex, OpenCode, Pi, CC Switch) for provider declarations. Literal API keys are never imported — only environment-variable references map to the credential field.",
          )}
        </p>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        {!groups && !error && <p className="text-sm opacity-60">{t("Scanning…")}</p>}

        {groups && (
          <>
            <div className="flex items-center gap-2">
              <input
                className={INPUT}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Search providers…")}
                aria-label={t("Search providers…")}
              />
              <span className="shrink-0 text-xs opacity-60">
                {t("Providers found: {{count}}", { count: q ? visibleFound : totalFound })}
              </span>
            </div>
            <div className="flex flex-col gap-2 overflow-y-auto">
              {visibleGroups.map((group) => (
                <div key={group.source} className="rounded-md border border-border" data-source={group.source}>
                  <label className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={group.entries.every((e) => selected.has(e.key))}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            !group.entries.every((e) => selected.has(e.key)) &&
                            group.entries.some((e) => selected.has(e.key));
                      }}
                      onChange={() => toggleGroup(group)}
                      aria-label={group.source}
                    />
                    <span>{sourceLabel(group.source)}</span>
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-normal opacity-70">
                      {group.entries.length}
                    </span>
                  </label>
                  <ul className="p-1">
                    {group.entries.map((e) => (
                      <li key={e.key}>
                        <label className="flex cursor-pointer items-start gap-2 rounded px-2 py-2 hover:bg-accent">
                          <input
                            className="mt-0.5"
                            type="checkbox"
                            checked={selected.has(e.key)}
                            onChange={() => toggle(e.key)}
                            aria-label={e.key}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate font-mono text-xs font-medium">{e.route}</span>
                              <span className="truncate text-xs opacity-60">{e.name}</span>
                            </span>
                            <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] opacity-60">
                              {e.baseURL && <span className="truncate">{e.baseURL}</span>}
                              {e.credential === "env" && e.apiKeyEnv && (
                                <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{e.apiKeyEnv}</span>
                              )}
                              {e.credential === "literal" && (
                                <span className="font-medium text-amber-700 opacity-100 dark:text-amber-400">
                                  {t("Literal key — not imported")}
                                </span>
                              )}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {totalFound === 0 && (
                <p className="text-sm opacity-60">{t("No provider configurations found on this machine.")}</p>
              )}
              {totalFound > 0 && q && visibleFound === 0 && (
                <p className="text-sm opacity-60">{t("Nothing found")}</p>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
              {literalCount > 0 ? (
                <p className="text-xs opacity-60">
                  {t("{{count}} selected entries carry literal keys; they import without credentials.", { count: literalCount })}
                </p>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button type="button" className={BTN} onClick={onClose} disabled={running}>
                  {t("Cancel")}
                </button>
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  id="btn-run-import"
                  disabled={selected.size === 0 || running}
                  onClick={() => void run()}
                >
                  {running ? t("Importing…") : t("Import selected ({{count}})", { count: selected.size })}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function countLiteral(groups: ImportGroup[], selected: Set<string>): number {
  return groups
    .flatMap((g) => g.entries)
    .filter((e) => selected.has(e.key) && e.credential === "literal").length;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
    case "cc-switch":
      return "CC Switch";
    default:
      return source;
  }
}
