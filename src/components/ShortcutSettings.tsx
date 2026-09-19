import { useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { translate } from "../i18n";
import { preferencesStore, usePreferencesStore } from "../store/preferencesStore";
import { checkShortcutAvailability } from "../shortcuts/shortcutAvailability";
import { formatShortcut, shortcutActions, shortcutFromEvent, shortcutValidationError, type ShortcutAction } from "../shortcuts/shortcuts";

export function ShortcutSettings() {
  const bindings = usePreferencesStore(state => state.shortcuts);
  const sendOnEnter = usePreferencesStore(state => state.sendOnEnter);
  const [recording, setRecording] = useState<ShortcutAction>();
  const [pending, setPending] = useState<ShortcutAction>();
  const [error, setError] = useState<{ action: ShortcutAction; text: string }>();
  const request = useRef(0);
  const recorder = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    request.current += 1;
    setRecording(undefined);
    setPending(undefined);
  };
  useEffect(() => () => { request.current += 1; }, []);

  const save = async (action: ShortcutAction, binding: string) => {
    const id = ++request.current;
    setPending(undefined);
    const localError = shortcutValidationError(binding);
    const duplicate = () => shortcutActions.find(candidate => candidate.id !== action &&
      preferencesStore.getState().shortcuts[candidate.id] === binding);
    const conflict = duplicate();
    setError(undefined);
    if (localError || conflict) {
      setError({ action, text: localError ?? translate("已用于“{{value0}}”", { value0: conflict!.label() }) });
      return;
    }
    setPending(action);
    try {
      const availability = await checkShortcutAvailability(binding);
      if (id !== request.current) return;
      if (availability !== "available") {
        setError({ action, text: availability === "conflict"
          ? translate("此快捷键已被系统或其他应用占用") : translate("当前环境无法检查系统快捷键") });
        return;
      }
      const latestConflict = duplicate();
      if (latestConflict) {
        setError({ action, text: translate("已用于“{{value0}}”", { value0: latestConflict.label() }) });
        return;
      }
      const state = preferencesStore.getState();
      state.setPreference("shortcuts", { ...state.shortcuts, [action]: binding });
      setRecording(undefined);
    } catch {
      if (id === request.current) setError({ action, text: translate("快捷键检查失败，请重试") });
    } finally {
      if (id === request.current) setPending(undefined);
    }
  };

  useEffect(() => {
    if (!recording) return;
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.isComposing || event.keyCode === 229 || event.repeat) return;
      if (event.key === "Escape") { cancel(); return; }
      if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
      const binding = shortcutFromEvent(event);
      if (binding) void save(recording, binding);
      else setError({ action: recording, text: translate("请选择组合键或功能键") });
    };
    const blur = () => cancel();
    window.addEventListener("keydown", capture, true);
    window.addEventListener("blur", blur);
    recorder.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("blur", blur);
    };
  }, [recording]);

  return (
    <div className="settings-detail-scroll">
      <section className="settings-section" aria-labelledby="shortcuts-heading">
        <div className="settings-section-heading"><h4 id="shortcuts-heading">{translate("快捷键")}</h4></div>
        <div className="preference-list">
          {shortcutActions.map(action => (
            <div className="shortcut-setting" key={action.id}>
              <div className="preference-row shortcut-row">
                <span id={`shortcut-${action.id}`}>{action.label()}</span>
                <div className="shortcut-controls">
                  <button type="button" className={`shortcut-recorder ${recording === action.id ? "is-recording" : ""}`}
                    ref={recording === action.id ? recorder : undefined}
                    data-shortcut-recorder="true" aria-labelledby={`shortcut-${action.id}`}
                    aria-pressed={recording === action.id} aria-busy={pending === action.id || undefined}
                    aria-describedby={error?.action === action.id ? `shortcut-error-${action.id}` : undefined}
                    onClick={() => { cancel(); setError(undefined); setRecording(action.id); }}
                    onBlur={() => { if (recording === action.id) cancel(); }}>
                    {pending === action.id ? translate("检查中…") : recording === action.id ? translate("请按快捷键") : formatShortcut(bindings[action.id])}
                  </button>
                  <button type="button" className="icon-button" aria-label={translate("清除{{value0}}快捷键", { value0: action.label() })}
                    title={translate("清除")} disabled={bindings[action.id] === null}
                    onClick={() => { cancel(); setError(undefined); const state = preferencesStore.getState(); state.setPreference("shortcuts", { ...state.shortcuts, [action.id]: null }); }}><X size={15} /></button>
                  <button type="button" className="icon-button" aria-label={translate("重置{{value0}}快捷键", { value0: action.label() })}
                    title={translate("恢复默认值")} disabled={bindings[action.id] === action.defaultBinding || pending === action.id}
                    onClick={() => { cancel(); void save(action.id, action.defaultBinding); }}><RotateCcw size={15} /></button>
                </div>
              </div>
              {error?.action === action.id && <div className="settings-error" id={`shortcut-error-${action.id}`} role="alert">{error.text}</div>}
            </div>
          ))}
        </div>
      </section>
      <section className="settings-section" aria-labelledby="input-heading">
        <div className="settings-section-heading"><h4 id="input-heading">{translate("录入")}</h4></div>
        <div className="preference-list"><label className="preference-row">
          <span>{translate("Enter 键发送")}</span>
          <input type="checkbox" role="switch" checked={sendOnEnter}
            onChange={event => preferencesStore.getState().setPreference("sendOnEnter", event.target.checked)} />
        </label></div>
      </section>
    </div>
  );
}
