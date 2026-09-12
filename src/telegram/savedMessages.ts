import { translate } from "../i18n";
import type { Avatar } from "./types";

// TDLib exposes the account photo on its self-chat; it is not the Saved Messages avatar.
export const savedMessagesAvatar = (): Avatar => ({
  label: translate("我"),
  color: "#3390ec",
  icon: "saved",
});
