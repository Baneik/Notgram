import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useElementVisibility } from "../hooks/useElementVisibility";

interface TextSpoilerGroupState {
  revealed: ReadonlySet<string>;
  reveal: (spoilerId: string) => void;
}

const TextSpoilerContext = createContext<TextSpoilerGroupState | undefined>(undefined);

interface TextSpoilerGroupProps extends HTMLAttributes<HTMLDivElement> {
  resetKey: string;
}

export function TextSpoilerGroup({ resetKey, children, ...props }: TextSpoilerGroupProps) {
  const [visibilityRef, visible] = useElementVisibility<HTMLDivElement>("0px");
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setRevealed(new Set());
  }, [resetKey]);

  useEffect(() => {
    if (!visible) setRevealed(new Set());
  }, [visible]);

  const context = useMemo<TextSpoilerGroupState>(() => ({
    revealed,
    reveal: (spoilerId) => {
      setRevealed((current) => current.has(spoilerId)
        ? current
        : new Set([...current, spoilerId]));
    },
  }), [revealed]);

  return (
    <TextSpoilerContext.Provider value={context}>
      <div ref={visibilityRef} {...props}>{children}</div>
    </TextSpoilerContext.Provider>
  );
}

export function TextSpoiler({ spoilerId, children }: {
  spoilerId: string;
  children: ReactNode;
}) {
  const group = useContext(TextSpoilerContext);
  const [localRevealed, setLocalRevealed] = useState(false);
  const revealed = group ? group.revealed.has(spoilerId) : localRevealed;
  const reveal = (event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>) => {
    if (revealed) return;
    event.preventDefault();
    event.stopPropagation();
    if (group) group.reveal(spoilerId);
    else setLocalRevealed(true);
  };

  return (
    <span
      className={`rich-spoiler ${revealed ? "is-revealed" : "is-concealed"}`}
      data-spoiler-state={revealed ? "revealed" : "concealed"}
      role={revealed ? undefined : "button"}
      tabIndex={revealed ? undefined : 0}
      aria-label={revealed ? undefined : "显示遮罩文字"}
      onClick={reveal}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") reveal(event);
      }}
    >
      {children}
    </span>
  );
}

export function MediaSpoiler({ active, resetKey, children }: {
  active: boolean;
  resetKey: string;
  children: ReactNode;
}) {
  const [visibilityRef, visible] = useElementVisibility<HTMLDivElement>("0px");
  const [revealed, setRevealed] = useState(false);
  const prismId = useId().replace(/:/g, "");
  const prismGradientId = `${prismId}-gradient`;
  const prismPatternId = `${prismId}-pattern`;
  const prismFilterId = `${prismId}-filter`;

  useEffect(() => {
    setRevealed(false);
  }, [active, resetKey]);

  useEffect(() => {
    if (!visible) setRevealed(false);
  }, [visible]);

  if (!active) return <>{children}</>;
  const concealed = !revealed;

  return (
    <div
      ref={visibilityRef}
      className={`media-spoiler ${concealed ? "is-concealed" : "is-revealed"}`}
      data-spoiler-state={concealed ? "concealed" : "revealed"}
    >
      <div
        className="media-spoiler-content"
        inert={concealed ? true : undefined}
        aria-hidden={concealed ? true : undefined}
      >
        {children}
      </div>
      <svg className="media-spoiler-prism-definitions" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={prismGradientId} x1="0%" y1="0%" x2="100%" y2="0%" spreadMethod="repeat">
            <stop offset="0%" stopColor="#000000" />
            <stop offset="50%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#000000" />
          </linearGradient>
          <pattern id={prismPatternId} width="24" height="1" patternUnits="userSpaceOnUse">
            <rect width="24" height="1" fill={`url(#${prismGradientId})`} />
          </pattern>
          <filter id={prismFilterId} x="0%" y="0%" width="100%" height="100%">
            <feImage href={`#${prismPatternId}`} result="grid" preserveAspectRatio="none" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="grid"
              scale="35"
              xChannelSelector="R"
              yChannelSelector="R"
            />
          </filter>
        </defs>
      </svg>
      <span
        className="media-spoiler-prism"
        aria-hidden="true"
        style={{ filter: `url(#${prismFilterId})` }}
      />
      {concealed && (
        <button
          className="media-spoiler-reveal"
          type="button"
          aria-label="显示遮罩媒体"
          title="显示媒体"
          onClick={() => setRevealed(true)}
        />
      )}
    </div>
  );
}
