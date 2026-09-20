import { translate } from "../i18n";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";

interface ConfirmActionDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  checkbox?: {
    label: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
  };
  error?: string;
  onConfirm: () => Promise<boolean>;
  onClose: () => void;
}

export function ConfirmActionDialog({
  title,
  description,
  confirmLabel,
  confirmDisabled = false,
  checkbox,
  error,
  onConfirm,
  onClose,
}: ConfirmActionDialogProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialogRef = useModalFocus<HTMLElement>(onClose, pending);

  const confirm = async () => {
    if (pending || confirmDisabled) return;
    setPending(true);
    setFailed(false);
    try {
      if (await onConfirm()) onClose();
      else setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="message-delete-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="message-delete-dialog confirm-action-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-action-title"
        aria-describedby="confirm-action-description"
        tabIndex={-1}
      >
        <div className="confirm-action-heading">
          <h3 id="confirm-action-title">{title}</h3>
          <p id="confirm-action-description">{description}</p>
        </div>
        {checkbox && (
          <label className="confirm-action-checkbox">
            <input
              type="checkbox"
              checked={checkbox.checked}
              disabled={pending || checkbox.disabled}
              onChange={event => checkbox.onChange(event.target.checked)}
            />
            <span>{checkbox.label}</span>
          </label>
        )}
        {failed && error && <p role="alert">{error}</p>}
        <div className="message-delete-actions">
          <button className="dialog-secondary" type="button" disabled={pending} onClick={onClose}>{translate("取消")}</button>
          <button className="dialog-danger" type="button" disabled={pending || confirmDisabled} onClick={() => void confirm()}>
            {pending && <LoaderCircle className="spin" size={16} />}
            <span>{confirmLabel}</span>
          </button>
        </div>
      </section>
    </div>
  );
}
