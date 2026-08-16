import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
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

const mediaSpoilerParticles = Array.from({ length: 56 }, (_, index) => {
  const random = (salt: number) => {
    const value = Math.sin((index + 1) * (salt + 1) * 12.9898) * 43758.5453;
    return value - Math.floor(value);
  };
  return {
    x: random(0) * 100,
    y: random(1) * 100,
    size: 1.5 + random(2) * 2.8,
    dx: -14 + random(3) * 28,
    dy: -12 + random(4) * 24,
    opacity: .28 + random(5) * .48,
    duration: 3.4 + random(6) * 3.8,
    delay: random(7) * -6,
  };
});

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
      {concealed && (
        <>
          <span className="media-spoiler-particles" aria-hidden="true">
            {mediaSpoilerParticles.map((particle, index) => (
              <span
                className="media-spoiler-particle"
                key={index}
                style={{
                  "--spoiler-particle-x": `${particle.x}%`,
                  "--spoiler-particle-y": `${particle.y}%`,
                  "--spoiler-particle-size": `${particle.size}px`,
                  "--spoiler-particle-dx": `${particle.dx}px`,
                  "--spoiler-particle-dy": `${particle.dy}px`,
                  "--spoiler-particle-opacity": particle.opacity,
                  "--spoiler-particle-duration": `${particle.duration}s`,
                  "--spoiler-particle-delay": `${particle.delay}s`,
                } as CSSProperties}
              />
            ))}
          </span>
          <button
            className="media-spoiler-reveal"
            type="button"
            aria-label="显示遮罩媒体"
            title="显示媒体"
            onClick={() => setRevealed(true)}
          />
        </>
      )}
    </div>
  );
}
