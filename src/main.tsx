import { App } from "./app/App";
import { WindowChrome } from "./components/WindowChrome";
import { mountWindow } from "./windows/mountWindow";

mountWindow(
  <div className="main-window-frame">
    <WindowChrome />
    <div className="main-window-content"><App /></div>
  </div>,
);
