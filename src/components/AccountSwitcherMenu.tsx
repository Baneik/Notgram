import { LoaderCircle, UserPlus } from "lucide-react";
import { useEffect, useRef } from "react";
import type { TelegramAccount, User } from "../telegram/types";
import { Avatar } from "./Avatar";

interface AccountSwitcherMenuProps {
  accounts: TelegramAccount[];
  activeAccountId: string;
  currentAccount?: User;
  pending: boolean;
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
  onAdd,
  onSwitch,
  onClose,
}: AccountSwitcherMenuProps) {
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const addAccountRef = useRef<HTMLButtonElement>(null);
  const visibleAccounts = visibleAccountsFor(accounts, activeAccountId, currentAccount)
    .filter((account) => account.id !== activeAccountId);
  useEffect(() => {
    (firstItemRef.current ?? addAccountRef.current)?.focus({ preventScroll: true });
  }, []);
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

  return (
    <div className="account-switcher-inline" role="menu" aria-label="切换账号">
      <div className="account-switcher-list">
        {visibleAccounts.map((account, index) => (
          <button
            className="account-switcher-item"
            type="button"
            role="menuitemradio"
            aria-checked={false}
            disabled={pending}
            key={account.id}
            ref={index === 0 ? firstItemRef : undefined}
            onClick={() => select(`${ACCOUNT_ACTION_PREFIX}${account.id}`)}
          >
            <Avatar avatar={account.avatar} size="small" />
            <span className="account-switcher-name">{account.displayName}</span>
          </button>
        ))}
      </div>
      <button
        className="account-switcher-add"
        type="button"
        role="menuitem"
        ref={addAccountRef}
        disabled={pending}
        onClick={() => select(ADD_ACCOUNT_ACTION)}
      >
        {pending
          ? <LoaderCircle className="spin" size={18} />
          : <UserPlus size={18} strokeWidth={1.9} />}
        <span>添加新账号</span>
      </button>
    </div>
  );
}
