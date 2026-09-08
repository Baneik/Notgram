import { Component, type ReactNode } from "react";
import { translate } from "../i18n";

/** Keep a discussion rendering failure from unmounting the rest of the client. */
export class DiscussionErrorBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? (
      <section className="channel-discussion-panel">
        <div className="channel-discussion-empty" role="alert">
          <span>{translate("留言加载失败")}</span>
          <button className="dialog-secondary" type="button" onClick={this.props.onClose}>{translate("返回频道")}</button>
        </div>
      </section>
    ) : this.props.children;
  }
}
