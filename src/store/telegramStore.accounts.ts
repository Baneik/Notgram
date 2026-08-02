import type { TelegramAccount, TelegramAccountState, User } from "../telegram/types";
import type { TelegramState } from "./telegramStore.types";

type AccountRegistrationState = Pick<
  TelegramState,
  "activeAccountId" | "authorization" | "currentUserId" | "users"
>;

export const currentAccountRegistration = (state: AccountRegistrationState) => {
  const user = state.currentUserId ? state.users.get(state.currentUserId) : undefined;
  if (!user || state.authorization.kind !== "ready") return undefined;
  return {
    accountId: state.activeAccountId,
    key: registrationKey(state.activeAccountId, user),
    account: {
      userId: user.id,
      displayName: user.displayName,
      avatar: user.avatar,
    },
  };
};

const registrationKey = (accountId: string, user: User) =>
  `${accountId}:${user.id}:${user.displayName}:${user.avatar.label}:${user.avatar.color}`;

export const accountStatePatch = (accountState: TelegramAccountState) => ({
  accounts: accountState.accounts,
  activeAccountId: accountState.activeAccountId,
  accountPending: false,
  accountError: undefined,
});

export const shouldDiscardUnregisteredAccount = (
  accounts: TelegramAccount[],
  previousAccountId: string,
  nextAccountId: string,
) => previousAccountId !== nextAccountId &&
  !accounts.some((account) => account.id === previousAccountId);
