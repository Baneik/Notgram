import { Download, FileArchive, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { appDiagnostics } from "../release/diagnostics";

type DiagnosticsStatus = "idle" | "saved" | "cancelled" | "error";
type DiagnosticsActivity = "loadingSettings" | "updatingConsent" | "exporting";

export function DiagnosticsSettings() {
  const supported = appDiagnostics.isAvailable();
  const [crashReportingEnabled, setCrashReportingEnabled] = useState(false);
  const [activity, setActivity] = useState<DiagnosticsActivity | undefined>(
    supported ? "loadingSettings" : undefined,
  );
  const [status, setStatus] = useState<DiagnosticsStatus>("idle");
  const busy = activity !== undefined;

  useEffect(() => {
    let active = true;
    void appDiagnostics.settings().then((settings) => {
      if (!active) return;
      setCrashReportingEnabled(settings.crashReportingEnabled);
      setStatus("idle");
    }).catch(() => {
      if (active) setStatus("error");
    }).finally(() => {
      if (active) setActivity(undefined);
    });
    return () => { active = false; };
  }, []);

  const changeCrashReporting = async (enabled: boolean) => {
    setActivity("updatingConsent");
    setStatus("idle");
    try {
      const settings = await appDiagnostics.setCrashReportingEnabled(enabled);
      setCrashReportingEnabled(settings.crashReportingEnabled);
    } catch {
      setStatus("error");
    } finally {
      setActivity(undefined);
    }
  };

  const exportBundle = async () => {
    setActivity("exporting");
    setStatus("idle");
    try {
      setStatus(await appDiagnostics.exportBundle() ? "saved" : "cancelled");
    } catch {
      setStatus("error");
    } finally {
      setActivity(undefined);
    }
  };

  const statusText = (() => {
    if (!supported) return "浏览器预览不生成诊断包";
    if (activity === "loadingSettings") return "正在读取设置";
    if (activity === "updatingConsent") return "正在保存设置";
    if (activity === "exporting") return "正在生成诊断包";
    if (status === "saved") return "诊断包已导出";
    if (status === "cancelled") return "已取消导出";
    if (status === "error") return "诊断操作失败";
    return "等待导出";
  })();

  return (
    <div className="settings-detail-scroll diagnostics-settings">
      <section className="settings-section" aria-labelledby="diagnostics-export-heading">
        <div className="settings-section-heading">
          <FileArchive size={18} strokeWidth={1.8} />
          <div>
            <h4 id="diagnostics-export-heading">诊断包</h4>
            <span>不包含消息正文、凭据或本机路径</span>
          </div>
        </div>
        <div className="diagnostics-command-row">
          <button
            className="dialog-secondary"
            type="button"
            disabled={busy || !supported}
            onClick={() => void exportBundle()}
          >
            {activity === "exporting"
              ? <LoaderCircle className="spin" size={17} />
              : <Download size={17} />}
            <span>导出诊断包</span>
          </button>
          <span className="diagnostics-status" role="status">{statusText}</span>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="crash-report-heading">
        <div className="settings-section-heading">
          <ShieldCheck size={18} strokeWidth={1.8} />
          <div>
            <h4 id="crash-report-heading">崩溃报告</h4>
            <span>仅在本地保留，随诊断包手动导出</span>
          </div>
        </div>
        <div className="preference-list">
          <label className="preference-row">
            <span>保留脱敏崩溃报告</span>
            <input
              type="checkbox"
              role="switch"
              checked={crashReportingEnabled}
              disabled={busy || !supported}
              onChange={(event) => void changeCrashReporting(event.target.checked)}
            />
          </label>
        </div>
      </section>
    </div>
  );
}
