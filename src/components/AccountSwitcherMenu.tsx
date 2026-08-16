import { Check, LoaderCircle, UserPlus } from "lucide-react";
import type { TelegramAccount, User } from "../telegram/types";
import { currentColorTheme } from "../theme/theme";
import { useNativeContextMenu } from "../contextMenu/nativeContextMenuBridge";
import { Avatar } from "./Avatar";
import {
  ContextMenuPanel,
  ContextMenuSurface,
  type ContextMenuPoint,
} from "./ContextMenuSurface";

interface AccountSwitcherMenuProps {
  accounts: TelegramAccount[];
  activeAccountId: string;
  currentAccount?: User;
  pending: boolean;
  point: ContextMenuPoint;
  restoreFocus: () => void;
  onAdd: () => Promise<boolean>;
  onSwitch: (accountId: string) => Promise<boolean>;
  onClose: () => void;
}

const ACCOUNT_ACTION_PREFIX = "account:";
const ADD_ACCOUNT_ACTION = "add-account";

const visibleAccountsFor = (
  accounts: TelegramAccount[],
  activeAccountId: string,
  currentAccount?: User,
) => {
  const visible = accounts.map((account) => account.id === activeAccountId && currentAccount
    ? {
        ...account,
        userId: currentAccount.id,
        displayName: currentAccount.displayName,
        avatar: currentAccount.avatar,
      }
    : account);
  if (currentAccount && !visible.some((account) => account.id === activeAccountId)) {
    visible.push({
      id: activeAccountId,
      userId: currentAccount.id,
      displayName: currentAccount.displayName,
      avatar: currentAccount.avatar,
    });
  }
  return visible;
};

export function AccountSwitcherMenu({
  accounts,
  activeAccountId,
  currentAccount,
  pending,
  point,
  restoreFocus,
  onAdd,
  onSwitch,
  onClose,
}: AccountSwitcherMenuProps) {
  const visibleAccounts = visibleAccountsFor(accounts, activeAccountId, currentAccount);
  const select = (actionId: string) => {
    onClose();
    if (actionId === ADD_ACCOUNT_ACTION) {
      void onAdd();
      return;
    }
    if (actionId.startsWith(ACCOUNT_ACTION_PREFIX)) {
      void onSwitch(actionId.slice(ACCOUNT_ACTION_PREFIX.length));
    }
  };
  const nativeMenu = useNativeContextMenu({
    label: "切换账号",
    colorTheme: currentColorTheme(),
    items: [
      ...visibleAccounts.map((account) => ({
        id: `${ACCOUNT_ACTION_PREFIX}${account.id}`,
        label: account.displayName,
        icon: "check" as const,
        avatar: account.avatar,
        checked: account.id === activeAccountId,
        disabled: pending,
      })),
      {
        id: ADD_ACCOUNT_ACTION,
        label: "添加新账号",
        icon: "user-plus" as const,
        disabled: pending,
        separatorBefore: true,
      },
    ],
  }, point, select, onClose, { placement: "anchor" });

  if (nativeMenu) return null;

  return (
    <ContextMenuSurface
      className="account-switcher-surface"
      label="切换账号"
      point={point}
      restoreFocus={restoreFocus}
      onClose={onClose}
    >
      <ContextMenuPanel className="account-switcher-panel">
        {visibleAccounts.map((account) => {
          const active = account.id === activeAccountId;
          return (
            <button
              className="account-switcher-item"
              type="button"
              role="menuitemradio"
              aria-checked={active}
              disabled={pending}
              key={account.id}
              onClick={() => select(`${ACCOUNT_ACTION_PREFIX}${account.id}`)}
            >
              <Avatar avatar={account.avatar} size="small" />
              <span>{account.displayName}</span>
              {active && <Check className="account-switcher-check" size={16} strokeWidth={2.2} />}
            </button>
          );
        })}
        <button
          className="account-switcher-add"
          type="button"
          role="menuitem"
          disabled={pending}
          onClick={() => select(ADD_ACCOUNT_ACTION)}
        >
          {pending
            ? <LoaderCircle className="spin" size={19} />
            : <UserPlus size={19} strokeWidth={1.9} />}
          <span>添加新账号</span>
        </button>
      </ContextMenuPanel>
    </ContextMenuSurface>
  );
}
