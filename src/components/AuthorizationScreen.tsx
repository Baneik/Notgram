import {
  ArrowLeft,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Phone,
  Settings,
  Timer,
  UserRound,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import notgramLogoUrl from "../../assets/app-icon.svg";
import { connectionPresentation } from "../telegram/connectionState";
import type { AuthorizationAction, AuthorizationState, ConnectionStatus } from "../telegram/types";

const QR_EXPIRY_SECONDS = 60;

interface AuthorizationScreenProps {
  state: AuthorizationState;
  pending: boolean;
  error?: string;
  connectionStatus: ConnectionStatus;
  inactive?: boolean;
  backPending?: boolean;
  onSubmit: (action: AuthorizationAction) => Promise<void>;
  onOpenSettings: () => void;
  onBack?: () => void;
}

export function AuthorizationScreen({
  state,
  pending,
  error,
  connectionStatus,
  inactive = false,
  backPending = false,
  onSubmit,
  onOpenSettings,
  onBack,
}: AuthorizationScreenProps) {
  const [phoneMode, setPhoneMode] = useState(false);
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState("");
  const [qrSecondsRemaining, setQrSecondsRemaining] = useState(QR_EXPIRY_SECONDS);
  const qrRequested = useRef(false);
  const qrLink = state.kind === "waitOtherDeviceConfirmation" ? state.link : undefined;

  useEffect(() => {
    setPrimary(state.kind === "waitPhoneNumber" ? "+86 " : "");
    setSecondary("");
  }, [state.kind]);

  useEffect(() => {
    if (state.kind === "waitPhoneNumber" && !phoneMode && !qrRequested.current) {
      qrRequested.current = true;
      void onSubmit({ kind: "qr" });
    }
    if (state.kind !== "waitPhoneNumber") qrRequested.current = false;
  }, [onSubmit, phoneMode, state.kind]);

  useEffect(() => {
    if (state.kind !== "waitOtherDeviceConfirmation" || phoneMode) return;
    setQrSecondsRemaining(QR_EXPIRY_SECONDS);
    const timer = globalThis.setInterval(() => {
      setQrSecondsRemaining((seconds) => Math.max(0, seconds - 1));
    }, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [phoneMode, qrLink, state.kind]);

  const showQrLogin = !phoneMode && (
    state.kind === "waitPhoneNumber" || state.kind === "waitOtherDeviceConfirmation"
  );
  const showPhoneLogin = () => {
    if (!primary.trim()) setPrimary("+86 ");
    setPhoneMode(true);
  };
  const returnToQrLogin = () => {
    qrRequested.current = false;
    setPhoneMode(false);
  };

  if (showQrLogin) {
    const link = qrLink;
    return (
      <AuthLayout
        connectionStatus={connectionStatus}
        inactive={inactive}
        backPending={backPending}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
      >
        <section className="auth-qr-flow" aria-labelledby="auth-qr-title">
          <div className={`auth-qr-frame ${link ? "is-ready" : "is-loading"}`}>
            {link ? (
              <div className="auth-qr-code" aria-label="Telegram 登录二维码">
                <QRCodeSVG
                  value={link}
                  size={224}
                  level="M"
                  marginSize={3}
                  bgColor="var(--color-qr-background)"
                  fgColor="var(--color-qr-foreground)"
                />
              </div>
            ) : (
              <div className="auth-qr-placeholder" role="status">
                <LoaderCircle className="spin" size={24} />
                <span>正在生成二维码</span>
              </div>
            )}
          </div>

          <div className="auth-qr-heading">
            <h1 id="auth-qr-title">使用二维码登录</h1>
            <p>无需输入密码，在手机端确认即可</p>
          </div>

          <div className="auth-qr-expiry" role="status" aria-live="polite">
            <Timer size={15} />
            <span>{link
              ? qrSecondsRemaining > 0
                ? `${formatCountdown(qrSecondsRemaining)} 后失效`
                : "二维码即将刷新"
              : "正在准备安全登录"}</span>
          </div>

          <ol className="auth-steps">
            <li>
              <span>1</span>
              <div><strong>打开 Telegram</strong><small>在手机上进入 Telegram 应用</small></div>
            </li>
            <li>
              <span>2</span>
              <div><strong>进入设备管理</strong><small>设置 &gt; 设备 &gt; 链接桌面设备</small></div>
            </li>
            <li>
              <span>3</span>
              <div><strong>扫描并确认</strong><small>将摄像头对准上方二维码</small></div>
            </li>
          </ol>

          {error && <div className="auth-error" role="alert">{error}</div>}

          <div className="auth-alternative"><span>或</span></div>
          <button className="auth-phone-button" type="button" disabled={pending} onClick={showPhoneLogin}>
            <Phone size={18} />
            <span>使用手机号登录</span>
          </button>
        </section>
      </AuthLayout>
    );
  }

  const formState = state.kind === "waitOtherDeviceConfirmation" && phoneMode
    ? ({ kind: "waitPhoneNumber" } as const)
    : state;
  const definition = getStepDefinition(formState);
  if (!definition) {
    return (
      <AuthLayout
        connectionStatus={connectionStatus}
        inactive={inactive}
        backPending={backPending}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
      >
        <div className="auth-progress" role="status">
          <LoaderCircle className="spin" size={28} />
          <span>{state.kind === "closed" ? "连接已关闭" : "正在连接 Telegram"}</span>
        </div>
      </AuthLayout>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const action = definition.action(primary.trim(), secondary.trim());
    if (action) await onSubmit(action);
  };

  return (
    <AuthLayout
      connectionStatus={connectionStatus}
      inactive={inactive}
      backPending={backPending}
      onBack={onBack}
      onOpenSettings={onOpenSettings}
    >
      <form className="auth-form" onSubmit={submit}>
        <span className="auth-heading-icon">{definition.icon}</span>
        <div className="auth-form-heading">
          <h1>{definition.title}</h1>
          <p className="auth-description">{definition.description}</p>
          {definition.context && <p className="auth-context">{definition.context}</p>}
        </div>
        <label className="auth-field">
          <span>{definition.primaryLabel}</span>
          <input autoFocus autoComplete={definition.autoComplete} inputMode={definition.inputMode}
            maxLength={definition.maxLength} type={definition.inputType} value={primary}
            onChange={(event) => setPrimary(event.target.value)} required />
        </label>
        {definition.secondaryLabel && (
          <label className="auth-field"><span>{definition.secondaryLabel}</span>
            <input autoComplete="family-name" value={secondary} onChange={(event) => setSecondary(event.target.value)} />
          </label>
        )}
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="auth-submit" type="submit" disabled={pending || !primary.trim()}>
          {pending && <LoaderCircle className="spin" size={18} />}<span>{definition.submitLabel}</span>
        </button>
        {(state.kind === "waitPhoneNumber" || state.kind === "waitOtherDeviceConfirmation") && (
          <button className="auth-link-button" type="button" disabled={pending} onClick={returnToQrLogin}>
            <ArrowLeft size={17} /> 返回二维码登录
          </button>
        )}
      </form>
    </AuthLayout>
  );
}

function AuthLayout({
  children,
  connectionStatus,
  inactive,
  backPending,
  onBack,
  onOpenSettings,
}: {
  children: ReactNode;
  connectionStatus: ConnectionStatus;
  inactive: boolean;
  backPending: boolean;
  onBack?: () => void;
  onOpenSettings: () => void;
}) {
  const showConnectionWarning = (
    connectionStatus === "waitingForNetwork" ||
    connectionStatus === "proxyError" ||
    connectionStatus === "offline"
  );

  return (
    <main className="auth-shell" inert={inactive} aria-hidden={inactive || undefined}>
      {onBack && (
        <button className="auth-back icon-button" type="button" aria-label="返回账号" title="返回" disabled={backPending} onClick={onBack}>
          {backPending ? <LoaderCircle className="spin" size={20} /> : <ArrowLeft size={21} />}
        </button>
      )}
      <section className="auth-panel">
        <header className="auth-brand">
          <img src={notgramLogoUrl} alt="" />
          <strong>Notgram</strong>
        </header>
        <div className="auth-content">{children}</div>
        {showConnectionWarning && (
          <div className="auth-connection-warning" role="status">
            <CircleAlert size={16} />
            <span>{connectionPresentation(connectionStatus).label}</span>
          </div>
        )}
      </section>
      <button className="auth-settings icon-button" type="button" aria-label="设置" title="设置" onClick={onOpenSettings}>
        <Settings size={20} />
      </button>
      <span className="auth-disclaimer">基于 Telegram API 的第三方客户端</span>
    </main>
  );
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function getStepDefinition(state: AuthorizationState) {
  switch (state.kind) {
    case "waitPhoneNumber": return { title: "手机号登录", description: "输入与 Telegram 账号关联的手机号码。", primaryLabel: "手机号码", submitLabel: "继续", icon: <Phone size={28} />, autoComplete: "tel", inputMode: "tel" as const, inputType: "tel", context: undefined, maxLength: undefined, secondaryLabel: undefined, action: (phoneNumber: string) => phoneNumber ? ({ kind: "phone", phoneNumber } as const) : undefined };
    case "waitCode": return { title: "输入验证码", description: "验证码已发送至你的 Telegram 应用或手机。", primaryLabel: "验证码", submitLabel: "下一步", icon: <KeyRound size={28} />, autoComplete: "one-time-code", inputMode: "numeric" as const, inputType: "text", context: state.phoneNumber, maxLength: state.codeLength, secondaryLabel: undefined, action: (code: string) => code ? ({ kind: "code", code } as const) : undefined };
    case "waitPassword": return { title: "两步验证", description: "此账号启用了额外的登录密码。", primaryLabel: "密码", submitLabel: "登录", icon: <LockKeyhole size={28} />, autoComplete: "current-password", inputMode: "text" as const, inputType: "password", context: state.hint ? `提示：${state.hint}` : undefined, maxLength: undefined, secondaryLabel: undefined, action: (password: string) => password ? ({ kind: "password", password } as const) : undefined };
    case "waitEmailAddress": return { title: "邮箱验证", description: "输入用于接收登录验证码的邮箱地址。", primaryLabel: "邮箱", submitLabel: "发送验证码", icon: <Mail size={28} />, autoComplete: "email", inputMode: "email" as const, inputType: "email", context: undefined, maxLength: undefined, secondaryLabel: undefined, action: (emailAddress: string) => emailAddress ? ({ kind: "emailAddress", emailAddress } as const) : undefined };
    case "waitEmailCode": return { title: "邮箱验证码", description: "输入邮箱中收到的验证码。", primaryLabel: "验证码", submitLabel: "验证", icon: <KeyRound size={28} />, autoComplete: "one-time-code", inputMode: "numeric" as const, inputType: "text", context: state.emailPattern, maxLength: state.codeLength, secondaryLabel: undefined, action: (code: string) => code ? ({ kind: "emailCode", code } as const) : undefined };
    case "waitRegistration": return { title: "创建账号", description: "输入你希望在 Telegram 中显示的姓名。", primaryLabel: "名字", secondaryLabel: "姓氏", submitLabel: "创建账号", icon: <UserRound size={28} />, autoComplete: "given-name", inputMode: "text" as const, inputType: "text", context: undefined, maxLength: undefined, action: (firstName: string, lastName: string) => firstName ? ({ kind: "registration", firstName, lastName } as const) : undefined };
    default: return undefined;
  }
}
