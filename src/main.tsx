import { App } from "./app/App";
import { WindowChrome } from "./components/WindowChrome";
import { prepareNativeContextMenuWindow } from "./contextMenu/nativeContextMenuBridge";
import { mountWindow } from "./windows/mountWindow";

void prepareNativeContextMenuWindow().catch(() => undefined);

mountWindow(
  <div className="main-window-frame">
    <WindowChrome />
    <div className="main-window-content"><App /></div>
  </div>,
);
