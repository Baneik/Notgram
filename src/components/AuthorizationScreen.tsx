import {
  ArrowLeft,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Phone,
  Settings,
  Smartphone,
  UserRound,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AuthorizationAction, AuthorizationState, ConnectionStatus } from "../telegram/types";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";

interface AuthorizationScreenProps {
  state: AuthorizationState;
  pending: boolean;
  error?: string;
  connectionStatus: ConnectionStatus;
  onSubmit: (action: AuthorizationAction) => Promise<void>;
  onOpenSettings: () => void;
}

export function AuthorizationScreen({ state, pending, error, connectionStatus, onSubmit, onOpenSettings }: AuthorizationScreenProps) {
  const [phoneMode, setPhoneMode] = useState(false);
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState("");
  const qrRequested = useRef(false);

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

  if (state.kind === "waitPhoneNumber" && !phoneMode) {
    return (
      <AuthLayout connectionStatus={connectionStatus} onOpenSettings={onOpenSettings}>
        <div className="auth-progress" role="status">
          <LoaderCircle className="spin" size={28} />
          <span>正在生成登录二维码</span>
        </div>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="auth-link-button" type="button" onClick={() => setPhoneMode(true)}>
          使用手机号登录
        </button>
      </AuthLayout>
    );
  }

  if (state.kind === "waitOtherDeviceConfirmation" && !phoneMode) {
    return (
      <AuthLayout connectionStatus={connectionStatus} onOpenSettings={onOpenSettings}>
        <div className="auth-qr-code" aria-label="Telegram 登录二维码">
          <QRCodeSVG value={state.link} size={260} level="M" marginSize={4} bgColor="#ffffff" fgColor="#111111" />
        </div>
        <h1>扫描二维码登录</h1>
        <ol className="auth-steps">
          <li>在手机上打开 Telegram</li>
          <li>前往 设置 &gt; 设备 &gt; 链接桌面设备</li>
          <li>扫描此二维码并确认登录</li>
        </ol>
        <div className="auth-qr-status" role="status">
          <span className="connection-dot" />
          <span>等待移动设备确认</span>
        </div>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="auth-link-button" type="button" onClick={() => setPhoneMode(true)}>
          使用手机号登录
        </button>
      </AuthLayout>
    );
  }

  const formState = state.kind === "waitOtherDeviceConfirmation" && phoneMode
    ? ({ kind: "waitPhoneNumber" } as const)
    : state;
  const definition = getStepDefinition(formState);
  if (!definition) {
    return (
      <AuthLayout connectionStatus={connectionStatus} onOpenSettings={onOpenSettings}>
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
    <AuthLayout connectionStatus={connectionStatus} onOpenSettings={onOpenSettings}>
      <form className="auth-form" onSubmit={submit}>
        <span className="auth-heading-icon">{definition.icon}</span>
        <h1>{definition.title}</h1>
        <p className="auth-description">{definition.description}</p>
        {definition.context && <p className="auth-context">{definition.context}</p>}
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
          <button className="auth-link-button" type="button" disabled={pending} onClick={() => { qrRequested.current = false; setPhoneMode(false); }}>
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
  onOpenSettings,
}: {
  children: ReactNode;
  connectionStatus: ConnectionStatus;
  onOpenSettings: () => void;
}) {
  return (
    <main className="auth-shell">
      <button className="auth-settings icon-button" type="button" aria-label="设置" title="设置" onClick={onOpenSettings}>
        <Settings size={21} />
      </button>
      <section className="auth-panel">
        <div className="auth-brand"><span className="brand-mark">N</span><strong>Notgram</strong></div>
        <div className="auth-content">{children}</div>
        <ConnectionStatusIndicator className="auth-connection-status" status={connectionStatus} />
      </section>
      <span className="auth-disclaimer">基于 Telegram API 的第三方客户端</span>
    </main>
  );
}

function getStepDefinition(state: AuthorizationState) {
  switch (state.kind) {
    case "waitPhoneNumber": return { title: "手机号登录", description: "请选择国家并输入你的手机号码。", primaryLabel: "手机号码", submitLabel: "继续", icon: <Phone size={30} />, autoComplete: "tel", inputMode: "tel" as const, inputType: "tel", context: undefined, maxLength: undefined, secondaryLabel: undefined, action: (phoneNumber: string) => phoneNumber ? ({ kind: "phone", phoneNumber } as const) : undefined };
    case "waitCode": return { title: "输入验证码", description: "验证码已发送至你的 Telegram 应用或手机。", primaryLabel: "验证码", submitLabel: "下一步", icon: <KeyRound size={30} />, autoComplete: "one-time-code", inputMode: "numeric" as const, inputType: "text", context: state.phoneNumber, maxLength: state.codeLength, secondaryLabel: undefined, action: (code: string) => code ? ({ kind: "code", code } as const) : undefined };
    case "waitPassword": return { title: "两步验证", description: "此账号启用了额外的登录密码。", primaryLabel: "密码", submitLabel: "登录", icon: <LockKeyhole size={30} />, autoComplete: "current-password", inputMode: "text" as const, inputType: "password", context: state.hint ? `提示：${state.hint}` : undefined, maxLength: undefined, secondaryLabel: undefined, action: (password: string) => password ? ({ kind: "password", password } as const) : undefined };
    case "waitEmailAddress": return { title: "邮箱验证", description: "输入用于接收登录验证码的邮箱地址。", primaryLabel: "邮箱", submitLabel: "发送验证码", icon: <Mail size={30} />, autoComplete: "email", inputMode: "email" as const, inputType: "email", context: undefined, maxLength: undefined, secondaryLabel: undefined, action: (emailAddress: string) => emailAddress ? ({ kind: "emailAddress", emailAddress } as const) : undefined };
    case "waitEmailCode": return { title: "邮箱验证码", description: "输入邮箱中收到的验证码。", primaryLabel: "验证码", submitLabel: "验证", icon: <KeyRound size={30} />, autoComplete: "one-time-code", inputMode: "numeric" as const, inputType: "text", context: state.emailPattern, maxLength: state.codeLength, secondaryLabel: undefined, action: (code: string) => code ? ({ kind: "emailCode", code } as const) : undefined };
    case "waitRegistration": return { title: "创建账号", description: "输入你希望在 Telegram 中显示的姓名。", primaryLabel: "名字", secondaryLabel: "姓氏", submitLabel: "创建账号", icon: <UserRound size={30} />, autoComplete: "given-name", inputMode: "text" as const, inputType: "text", context: undefined, maxLength: undefined, action: (firstName: string, lastName: string) => firstName ? ({ kind: "registration", firstName, lastName } as const) : undefined };
    default: return undefined;
  }
}
