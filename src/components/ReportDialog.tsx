import { ArrowLeft, Check, ChevronRight, LoaderCircle, ShieldAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { translate } from "../i18n";
import { useModalFocus } from "../hooks/useModalFocus";
import { useTelegramStore } from "../store/telegramStore";
import { REPORT_TEXT_LIMIT } from "../telegram/chatReport";
import { reportReasonLabel } from "../telegram/reportLabels";
import type { ChatReportResult, ReportChatInput, ReportOption } from "../telegram/types";
import { ReportMessagePicker } from "./ReportMessagePicker";

interface ReportDialogProps {
  chatId: string;
  messageIds: string[];
  title: string;
  onGetOptions: (chatId: string, messageIds: string[]) => Promise<ChatReportResult>;
  onSubmit: (input: ReportChatInput) => Promise<ChatReportResult>;
  onLeaveChat?: () => Promise<boolean>;
  onClose: () => void;
}

interface ReportStep {
  result: ChatReportResult;
  request: ReportChatInput;
  path: ReportOption[];
  selectedOption?: string;
  draft: string;
}

export function ReportDialog(props: ReportDialogProps) {
  const accountId = useTelegramStore(state => state.activeAccountId);
  const [sessionAccountId] = useState(accountId);
  useEffect(() => {
    if (accountId !== sessionAccountId) props.onClose();
  }, [accountId, sessionAccountId, props.onClose]);
  // Switching accounts must not start a new report for the previous account's
  // target. Unmount immediately so its pending completion cannot trigger a leave.
  if (accountId !== sessionAccountId) return null;
  // Inline messageIds arrays are common at the three entry points. Identity must
  // depend on their values, while a new target must discard the old flow.
  return <ReportSession key={JSON.stringify([props.chatId, props.messageIds])} {...props} />;
}

function ReportSession({ chatId, messageIds, title, onGetOptions, onSubmit, onLeaveChat, onClose }: ReportDialogProps) {
  useTranslation();
  const id = useId();
  const [steps, setSteps] = useState<ReportStep[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"load" | "submit" | "leave">();
  const [leaveChat, setLeaveChat] = useState(false);
  const [leftChat, setLeftChat] = useState(false);
  const [retry, setRetry] = useState(0);
  const initial = useRef<Promise<ChatReportResult> | undefined>(undefined);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const close = () => { alive.current = false; onClose(); };
  const dialogRef = useModalFocus<HTMLElement>(close);
  const step = steps.at(-1);
  const result = step?.result;
  const completed = result?.kind === "ok";

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    // StrictMode may replay effects. Reuse the initial request, which can itself
    // report action-bar spam, instead of issuing a second report.
    initial.current ??= onGetOptions(chatId, messageIds);
    setPending(true);
    setError(undefined);
    void initial.current.then(value => {
      if (active && alive.current) setSteps([{ result: value, request: { chatId, messageIds, optionId: "", text: "" }, path: [], draft: "" }]);
    }).catch(() => {
      if (active && alive.current) setError("load");
    }).finally(() => {
      if (active && alive.current) setPending(false);
    });
    return () => { active = false; };
    // Scope is fixed by ReportSession's key. Renders and language changes must
    // never restart a server report or lose an in-progress comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry]);

  useEffect(() => { if (steps.length) headingRef.current?.focus(); }, [steps.length]);

  const updateStep = (changes: Partial<ReportStep>) => setSteps(current => current.map((entry, index) => index === current.length - 1 ? { ...entry, ...changes } : entry));
  const leaveGroup = async () => {
    if (!onLeaveChat || !alive.current) return;
    try {
      const left = await onLeaveChat();
      if (!alive.current) return;
      if (left) { setLeftChat(true); setError(undefined); }
      else setError("leave");
    } catch { if (alive.current) setError("leave"); }
  };
  const submit = async () => {
    if (!step || pending || inFlight.current || completed) return;
    let request: ReportChatInput;
    let path = step.path;
    if (result?.kind === "options") {
      const option = result.options.find(option => option.id === step.selectedOption);
      if (!option) return;
      request = { ...step.request, optionId: option.id, text: "" };
      path = [...path, option];
    } else if (result?.kind === "text") {
      if (!result.isOptional && !step.draft.trim()) return;
      request = { ...step.request, optionId: result.optionId, text: step.draft.trim() };
    } else if (result?.kind === "messages") {
      if (step.request.messageIds.length === 0) return;
      // MessagesRequired carries no option ID. Repeat the exact request that
      // produced it, adding the selected evidence and preserving any comment.
      request = step.request;
    } else return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      const next = await onSubmit(request);
      if (!alive.current) return;
      setSteps(current => [...current, { result: next, request, path, draft: request.text ?? "" }]);
      if (next.kind === "ok" && leaveChat) await leaveGroup();
    } catch { if (alive.current) setError("submit"); }
    finally {
      inFlight.current = false;
      if (alive.current) setPending(false);
    }
  };
  const goBack = () => {
    if (pending || inFlight.current) return;
    setSteps(current => current.slice(0, -1));
    setError(undefined);
  };
  const retryLeave = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    await leaveGroup();
    inFlight.current = false;
    if (alive.current) setPending(false);
  };
  const stepTitle = completed ? translate("举报已提交")
    : result?.kind === "text" ? translate("补充举报说明")
    : result?.kind === "messages" ? translate("选择举报消息")
    : result?.kind === "options" && result.title.trim() ? reportReasonLabel(result.title)
    : translate("选择举报原因");
  const disabled = pending || !step || (result?.kind === "options" && step.selectedOption === undefined)
    || (result?.kind === "text" && !result.isOptional && !step.draft.trim())
    || (result?.kind === "messages" && step.request.messageIds.length === 0);

  return <div className="profile-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialogRef} className="report-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
      <header>
        <div><h2 id={`${id}-title`}>{translate("举报“{{title}}”", { title })}</h2>
          <small>{translate("举报会发送给 Telegram 审核")}</small></div>
        <button className="icon-button" type="button" aria-label={translate("关闭举报")} onClick={close}><X size={18} /></button>
      </header>
      <div className="report-dialog-body" aria-busy={pending}>
        <div className="report-step-heading">
          {steps.length > 1 && !completed && <button className="icon-button" type="button" aria-label={translate("返回上一级")} disabled={pending} onClick={goBack}><ArrowLeft size={18} /></button>}
          <h3 ref={headingRef} tabIndex={-1}>{stepTitle}</h3>
        </div>
        {step && step.path.length > 0 && <ol className="report-path" aria-label={translate("已选举报原因")}>
          {step.path.map((option, index) => <li key={`${index}:${option.id}`}>{index > 0 && <ChevronRight size={12} />}{reportReasonLabel(option.title)}</li>)}
        </ol>}
        {step && step.request.messageIds.length > 0 && result?.kind !== "messages" && <p className="report-help">{translate("已选择 {{value0}} 条消息", { value0: step.request.messageIds.length })}</p>}
        {!result && pending && <p className="report-help" role="status"><LoaderCircle size={18} className="spin" />{translate("正在加载举报选项")}</p>}
        {result?.kind === "options" && <fieldset className="report-reason-options" disabled={pending}>
          <legend className="sr-only">{translate("举报原因")}</legend>
          {result.options.map(option => <label key={option.id} className={step?.selectedOption === option.id ? "is-selected" : ""}>
            <input type="radio" name={`${id}-reason`} value={option.id} checked={step?.selectedOption === option.id}
              onChange={() => updateStep({ selectedOption: option.id })} />
            <span>{reportReasonLabel(option.title)}</span><ChevronRight size={15} aria-hidden="true" />
          </label>)}
        </fieldset>}
        {result?.kind === "text" && step && <label className="report-comment">
          <span>{result.isOptional ? translate("补充说明（选填）") : translate("补充说明（必填）")}</span>
          <textarea aria-label={translate("举报说明")} aria-describedby={`${id}-count`} required={!result.isOptional} disabled={pending}
            value={step.draft} onChange={event => updateStep({ draft: Array.from(event.target.value).slice(0, REPORT_TEXT_LIMIT).join("") })}
            rows={5} placeholder={translate("请描述具体问题")} />
          <small id={`${id}-count`}>{translate("{{count}} / {{limit}} 个字符", { count: Array.from(step.draft).length, limit: REPORT_TEXT_LIMIT })}</small>
        </label>}
        {result?.kind === "messages" && step && <ReportMessagePicker chatId={chatId} selected={step.request.messageIds} disabled={pending}
          onChange={ids => updateStep({ request: { ...step.request, messageIds: ids } })} />}
        {completed && <div className="report-success" role="status"><Check size={30} /><p>{translate("感谢你的反馈，Telegram 将审核此举报。")}</p>
          {leftChat && <p>{translate("已退出群组")}</p>}</div>}
        {onLeaveChat && result && !completed && <label className="management-check report-delete-option">
          <input type="checkbox" checked={leaveChat} disabled={pending} onChange={event => setLeaveChat(event.target.checked)} />
          <span>{translate("举报成功后退出这个群组")}</span>
        </label>}
        {error && <p className="report-error" role="alert">{error === "load" ? translate("无法读取举报选项") : error === "leave"
          ? translate("举报已提交，但退出群组失败。请重试退出。") : translate("举报未提交，请检查说明后重试")}</p>}
        <footer>
          {completed ? <>
            {error === "leave" && <button type="button" className="dialog-secondary" disabled={pending} onClick={() => void retryLeave()}>{translate("重试退出群组")}</button>}
            <button type="button" className="dialog-secondary" onClick={close}>{translate("完成")}</button>
          </> : <>
            <button className="dialog-secondary" type="button" onClick={close}>{translate("取消")}</button>
            {error === "load" ? <button className="dialog-secondary" type="button" onClick={() => { initial.current = undefined; setRetry(value => value + 1); }}>{translate("重试")}</button>
              : <button className={result?.kind === "text" ? "dialog-danger" : "dialog-primary"} type="button" disabled={disabled} onClick={() => void submit()}>
                {pending ? <LoaderCircle size={15} className="spin" /> : result?.kind === "text" ? <ShieldAlert size={15} /> : <ChevronRight size={15} />}
                {result?.kind === "text" ? translate("提交举报") : translate("继续举报")}
              </button>}
          </>}
        </footer>
      </div>
    </section>
  </div>;
}
