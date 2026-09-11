import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Alert from "../common/Alert";
import Spinner from "../common/Spinner";
import { useToastStore } from "../../store/toast";
import { apiGet } from "../../api/client";
import {
  LOG_LEVELS,
  clearLogBuffer,
  exportLogs,
  getLogBuffer,
  getLoggerSettings,
  setLoggerSettings,
  type LogLevel,
} from "../../utils/logger";

interface ServerLogRecord {
  time: string;
  level: LogLevel;
  scope: string;
  msg: string;
  [field: string]: unknown;
}

interface LogCapabilities {
  logsApiEnabled?: boolean;
  clientLogsEnabled?: boolean;
}

interface LogsResponse {
  source: "file" | "memory";
  serverLevel: LogLevel;
  levels: LogLevel[];
  count: number;
  records: ServerLogRecord[];
}

const levelStyles: Record<LogLevel, string> = {
  error:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900/80 dark:bg-red-950/60 dark:text-red-300",
  warn: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/60 dark:text-amber-300",
  info: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/80 dark:bg-blue-950/60 dark:text-blue-300",
  debug:
    "border-gray-200 bg-gray-100 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300",
  trace:
    "border-gray-200 bg-gray-100 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

const REFRESH_INTERVAL_MS = 5000;
const selectClass =
  "block min-w-0 max-w-full w-full truncate rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors";

export default function LogsSection() {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);

  const [clientLevel, setClientLevel] = useState<LogLevel>(
    () => getLoggerSettings().level,
  );
  const [remote, setRemote] = useState(() => getLoggerSettings().remote);

  const [filterLevel, setFilterLevel] = useState<LogLevel>("info");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<LogsResponse | null>(null);
  const [error, setError] = useState("");
  const [serverEnabled, setServerEnabled] = useState(true);

  // Keeps the interval callback from closing over stale filter values.
  const queryRef = useRef({ filterLevel, search });
  queryRef.current = { filterLevel, search };

  useEffect(() => {
    apiGet<LogCapabilities>("/api/settings")
      .then((info) => setServerEnabled(info.logsApiEnabled !== false))
      .catch(() => setServerEnabled(true));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { filterLevel: level, search: q } = queryRef.current;
      const params = new URLSearchParams({ level, limit: "200" });
      if (q.trim()) params.set("q", q.trim());
      setData(await apiGet<LogsResponse>(`/api/logs?${params.toString()}`));
      setError("");
    } catch {
      setError(t("settings.logs.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (serverEnabled) void load();
  }, [load, filterLevel, serverEnabled]);

  useEffect(() => {
    if (!autoRefresh || !serverEnabled) return;
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, load, serverEnabled]);

  const handleExport = () => {
    const content = exportLogs();
    if (!content) {
      addToast(t("settings.logs.exportEmpty"), "error");
      return;
    }
    const blob = new Blob([content], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `asspp-browser-logs-${Date.now()}.ndjson`;
    a.click();
    URL.revokeObjectURL(url);
    addToast(t("settings.logs.exportSuccess"), "success");
  };

  return (
    <section className="min-w-0 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
        {t("settings.logs.title")}
      </h2>

      <div className="min-w-0 space-y-6">
        <div className="min-w-0 space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {t("settings.logs.browserTitle")}
          </h3>
          <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
            {t("settings.logs.browserDescription")}
          </p>

          <div>
            <label
              htmlFor="client-log-level"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t("settings.logs.clientLevel")}
            </label>
            <select
              id="client-log-level"
              value={clientLevel}
              onChange={(e) => {
                const level = e.target.value as LogLevel;
                setClientLevel(level);
                setLoggerSettings({ level });
              }}
              className={selectClass}
            >
              {LOG_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>

          <label className="flex min-w-0 items-start gap-3">
            <input
              type="checkbox"
              checked={remote}
              onChange={(e) => {
                setRemote(e.target.checked);
                setLoggerSettings({ remote: e.target.checked });
              }}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-700"
            />
            <span className="min-w-0 text-sm text-gray-700 dark:text-gray-300">
              <span className="font-medium text-gray-900 dark:text-white">
                {t("settings.logs.forward")}
              </span>
              <span className="mt-1 block text-gray-600 dark:text-gray-400">
                {t("settings.logs.forwardHint")}
              </span>
            </span>
          </label>

          <Alert type="warning">{t("settings.logs.privacyNote")}</Alert>

          <div className="grid w-full min-w-0 grid-cols-2 gap-3 sm:max-w-sm">
            <button
              onClick={handleExport}
              className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-blue-300 px-3 py-2 text-center text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 sm:px-4 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/30"
            >
              {t("settings.logs.exportBtn", { total: getLogBuffer().length })}
            </button>
            <button
              onClick={() => {
                clearLogBuffer();
                addToast(t("settings.logs.cleared"), "success");
              }}
              className="min-h-11 w-full min-w-0 whitespace-normal break-words rounded-lg border border-gray-300 px-3 py-2 text-center text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 sm:px-4 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {t("settings.logs.clearBtn")}
            </button>
          </div>
        </div>

        <div className="min-w-0 space-y-4 border-t border-gray-100 pt-6 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {t("settings.logs.serverTitle")}
          </h3>

          {!serverEnabled && (
            <Alert type="warning">{t("settings.logs.serverDisabled")}</Alert>
          )}

          <div
            className={`grid min-w-0 gap-3 sm:grid-cols-2 ${serverEnabled ? "" : "hidden"}`}
          >
            <div>
              <label
                htmlFor="server-log-level"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("settings.logs.filterLevel")}
              </label>
              <select
                id="server-log-level"
                value={filterLevel}
                onChange={(e) => setFilterLevel(e.target.value as LogLevel)}
                className={selectClass}
              >
                {LOG_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="server-log-search"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("settings.logs.search")}
              </label>
              <input
                id="server-log-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void load();
                }}
                placeholder={t("settings.logs.searchPlaceholder")}
                className="block min-w-0 max-w-full w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
              />
            </div>
          </div>

          <div
            className={`flex min-w-0 flex-wrap items-center gap-3 ${serverEnabled ? "" : "hidden"}`}
          >
            <button
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {loading && <Spinner />}
              {t("settings.logs.refresh")}
            </button>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-700"
              />
              {t("settings.logs.autoRefresh")}
            </label>
            {data && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t("settings.logs.meta", {
                  total: data.count,
                  source: data.source,
                  level: data.serverLevel,
                })}
              </span>
            )}
          </div>

          {error && serverEnabled && <Alert type="error">{error}</Alert>}

          {!serverEnabled ? null : data && data.records.length === 0 && !error ? (
            <div className="rounded-lg border-2 border-dashed border-gray-200 bg-gray-50 p-6 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900/30 dark:text-gray-400">
              {t("settings.logs.empty")}
            </div>
          ) : (
            <div className="max-h-96 min-w-0 overflow-auto rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-950/40">
              <ul className="min-w-0 divide-y divide-gray-200 dark:divide-gray-800">
                {data?.records.map((record, index) => (
                  <LogRow key={`${record.time}-${index}`} record={record} />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function LogRow({ record }: { record: ServerLogRecord }) {
  const { time, level, scope, msg, ...fields } = record;
  const extras = Object.entries(fields);

  return (
    <li className="min-w-0 px-3 py-2 font-mono text-xs leading-5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-gray-500 dark:text-gray-400">
          {time.slice(11, 23)}
        </span>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${
            levelStyles[level] ?? levelStyles.info
          }`}
        >
          {level}
        </span>
        <span className="text-purple-700 dark:text-purple-300">{scope}</span>
        <span className="min-w-0 break-all text-gray-900 dark:text-gray-100">
          {msg}
        </span>
      </div>
      {extras.length > 0 && (
        <div className="mt-1 min-w-0 break-all text-gray-600 dark:text-gray-400">
          {extras
            .map(
              ([key, value]) =>
                `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
            )
            .join("  ")}
        </div>
      )}
    </li>
  );
}
