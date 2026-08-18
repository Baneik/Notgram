import { DesktopNotificationWindow } from "../components/DesktopNotificationWindow";
import { mountWindow } from "./mountWindow";

document.documentElement.classList.add("notification-window-page");
document.body.classList.add("notification-window-page");

mountWindow(<DesktopNotificationWindow />);
