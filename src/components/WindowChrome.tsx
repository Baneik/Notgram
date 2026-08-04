import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

export function WindowChrome() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    const refresh = () => void window.isMaximized().then(setMaximized).catch(() => undefined);
    refresh();
    let unlisten: (() => void) | undefined;
    void window.onResized(refresh).then((stop) => { unlisten = stop; });
    return () => unlisten?.();
  }, []);

  const minimize = () => {
    if (isTauri()) void getCurrentWindow().minimize();
  };
  const toggleMaximize = () => {
    if (!isTauri()) return;
    void getCurrentWindow().toggleMaximize().then(() => {
      void getCurrentWindow().isMaximized().then(setMaximized);
    });
  };
  const close = () => {
    if (isTauri()) void getCurrentWindow().close();
  };

  return (
    <header className="window-chrome" aria-label="窗口操作">
      <div
        className="window-drag-region"
        data-tauri-drag-region
        onDoubleClick={toggleMaximize}
      />
      <div className="window-controls">
        <button type="button" aria-label="最小化窗口" title="最小化" onClick={minimize}>
          <Minus size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label={maximized ? "还原窗口" : "最大化窗口"}
          title={maximized ? "还原" : "最大化"}
          onClick={toggleMaximize}
        >
          {maximized ? <Square size={12} strokeWidth={1.8} /> : <Maximize2 size={13} strokeWidth={1.8} />}
        </button>
        <button className="window-close" type="button" aria-label="关闭窗口" title="关闭" onClick={close}>
          <X size={16} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  );
}
