import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";

interface ConfirmActionDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<boolean>;
  onClose: () => void;
}

export function ConfirmActionDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
}: ConfirmActionDialogProps) {
  const [pending, setPending] = useState(false);
  const dialogRef = useModalFocus<HTMLElement>(onClose, pending);

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    try {
      if (await onConfirm()) onClose();
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
        tabIndex={-1}
      >
        <div className="message-delete-heading">
          <span><AlertTriangle size={18} strokeWidth={1.9} /></span>
          <div>
            <h3 id="confirm-action-title">{title}</h3>
            <p>{description}</p>
          </div>
        </div>
        <div className="message-delete-actions">
          <button className="dialog-secondary" type="button" disabled={pending} onClick={onClose}>
            取消
          </button>
          <button className="dialog-danger" type="button" disabled={pending} onClick={() => void confirm()}>
            {pending && <LoaderCircle className="spin" size={16} />}
            <span>{confirmLabel}</span>
          </button>
        </div>
      </section>
    </div>
  );
}
