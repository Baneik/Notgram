import { Component, type ReactNode } from "react";

interface Props {
  identity: string;
  items: readonly { id: string }[];
  capture: (structuralChange: boolean) => (() => void) | undefined;
  children: ReactNode;
}

/** React's before-mutation lifecycle is needed here: a layout effect alone
 * observes the new rows and has already lost the user's pre-update viewport. */
export class ConversationViewportBoundary extends Component<Props, object, (() => void) | null> {
  getSnapshotBeforeUpdate(previous: Props) {
    if (previous.identity !== this.props.identity || previous.items === this.props.items) return null;
    // Appending below a reader does not relocate existing virtual rows.
    const structuralChange = previous.items.some((item, index) => item.id !== this.props.items[index]?.id);
    return this.props.capture(structuralChange) ?? null;
  }

  componentDidUpdate(_previous: Props, _state: object, restore: (() => void) | null) {
    restore?.();
  }

  render() {
    return this.props.children;
  }
}
