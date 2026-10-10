import { translate } from "../i18n";
import { useModalFocus } from "../hooks/useModalFocus";
import { ForumTopicsView } from "./ForumTopicsView";
import type { ComponentProps } from "react";

type Props = Omit<ComponentProps<typeof ForumTopicsView>, "onBack"> & { onClose: () => void };
export function ForumTopicManagerDialog({ onClose, ...props }: Props) {
  const ref = useModalFocus<HTMLElement>(onClose);
  return <div className="message-delete-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={ref} className="forum-topic-manager-dialog" role="dialog" aria-modal="true"
      aria-label={translate("管理话题")} tabIndex={-1}>
      <ForumTopicsView {...props} onBack={onClose} />
    </section>
  </div>;
}
