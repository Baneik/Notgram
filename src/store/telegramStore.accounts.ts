import { translate } from "../i18n";
import type { TelegramAccount, TelegramAccountState, User } from "../telegram/types";
import { sanitizeIdentityText } from "../telegram/identityText";
import type { TelegramState } from "./telegramStore.types";

type AccountRegistrationState = Pick<
  TelegramState,
  "activeAccountId" | "authorization" | "currentUserId" | "users"
>;

export const preserveUserAvatarMedia = (incoming: User, existing?: User): User => {
  if (!existing) return incoming;
  const sameFile = incoming.avatar.fileId !== undefined &&
    existing.avatar.fileId === incoming.avatar.fileId;
  if (!sameFile) return incoming;
  return {
    ...incoming,
    avatar: {
      ...incoming.avatar,
      imagePath: incoming.avatar.imagePath ?? existing.avatar.imagePath,
      fileId: incoming.avatar.fileId ?? existing.avatar.fileId,
      canDownload: incoming.avatar.canDownload ?? existing.avatar.canDownload,
      isDownloading: incoming.avatar.isDownloading ?? existing.avatar.isDownloading,
    },
  };
};

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
  `${accountId}:${user.id}:${user.displayName}:${user.avatar.label}:${user.avatar.color}:${user.avatar.fileId ?? ""}:${user.avatar.imagePath ?? ""}`;

export const accountStatePatch = (accountState: TelegramAccountState) => ({
  accounts: accountState.accounts.map((account) => {
    const displayName = sanitizeIdentityText(account.displayName, translate("Telegram 账号"), 128);
    return {
      ...account,
      displayName,
      avatar: {
        ...account.avatar,
        label: sanitizeIdentityText(
          account.avatar.label,
          [...displayName].slice(0, 2).join("") || "?",
          2,
        ),
      },
    };
  }),
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
