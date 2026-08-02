import { CheckCircle2, CloudDownload, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  appUpdater,
  type AppDistribution,
  type AppUpdateInfo,
  type AppUpdateProgress,
} from "../release/appUpdater";

type UpdateState = "idle" | "checking" | "current" | "available" | "installing" | "error";

const updateChannel = (version: string) => version.includes("-") ? "候选通道" : "稳定通道";

export function UpdateSettings() {
  const [distribution, setDistribution] = useState<AppDistribution>();
  const [currentVersion, setCurrentVersion] = useState("-");
  const [state, setState] = useState<UpdateState>("idle");
  const [update, setUpdate] = useState<AppUpdateInfo>();
  const [progress, setProgress] = useState<AppUpdateProgress>();

  useEffect(() => {
    let active = true;
    void appUpdater.distribution().then((value) => {
      if (active) setDistribution(value);
    }).catch(() => {
      if (active) setDistribution("unknown");
    });
    void appUpdater.currentVersion().then((version) => {
      if (active) setCurrentVersion(version);
    }).catch(() => {
      if (active) setCurrentVersion("未知版本");
    });
    return () => { active = false; };
  }, []);

  const supported = distribution === "installed";

  const check = async () => {
    setState("checking");
    setUpdate(undefined);
    try {
      const next = await appUpdater.check();
      setUpdate(next);
      setState(next ? "available" : "current");
    } catch {
      setState("error");
    }
  };

  const install = async () => {
    setState("installing");
    setProgress(undefined);
    try {
      await appUpdater.install(setProgress);
    } catch {
      setState("error");
    }
  };

  return (
    <div className="settings-detail-scroll update-settings">
      <section className="settings-section" aria-labelledby="update-version-heading">
        <div className="settings-section-heading">
          <CloudDownload size={18} strokeWidth={1.8} />
          <div>
            <h4 id="update-version-heading">Notgram {currentVersion}</h4>
            <span>{updateChannel(currentVersion)}</span>
          </div>
        </div>

        <div className="update-status" role="status" aria-live="polite">
          {state === "current" ? (
            <><CheckCircle2 size={18} /><span>当前已是最新版本</span></>
          ) : state === "available" && update ? (
            <><CloudDownload size={18} /><span>可更新至 {update.version}</span></>
          ) : state === "installing" ? (
            <><LoaderCircle className="spin" size={18} /><span>正在安装 {update?.version}</span></>
          ) : state === "error" ? (
            <><RefreshCw size={18} /><span>更新操作失败，请稍后重试</span></>
          ) : distribution === "portable" ? (
            <span>便携版通过新版 ZIP 更新</span>
          ) : distribution === "browser" ? (
            <span>浏览器预览</span>
          ) : distribution === "unknown" ? (
            <span>当前分发方式不支持自动更新</span>
          ) : (
            <span>{supported ? "尚未检查" : "正在读取版本"}</span>
          )}
        </div>

        {state === "installing" && (
          <progress
            className="update-progress"
            aria-label="更新下载进度"
            max={1}
            value={progress?.fraction}
          />
        )}

        {update?.notes && (
          <div className="update-notes">
            <strong>{update.version}</strong>
            <p>{update.notes}</p>
          </div>
        )}

        <div className="settings-inline-actions">
          <button
            className="dialog-secondary"
            type="button"
            disabled={!supported || state === "checking" || state === "installing"}
            onClick={() => void check()}
          >
            {state === "checking"
              ? <LoaderCircle className="spin" size={16} />
              : <RefreshCw size={16} />}
            检查更新
          </button>
          {(state === "available" || (state === "error" && update)) && (
            <button className="dialog-save" type="button" onClick={() => void install()}>
              <CloudDownload size={16} />
              {state === "error" ? "重试安装" : "下载并安装"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
