import katex from "katex";
import "katex/dist/katex.min.css";
import { useContext, useLayoutEffect } from "react";
import { MessageTextLayoutContext } from "./MessageTextFlow";

interface RichMathExpressionProps {
  expression: string;
  displayMode: boolean;
}

function RichMathExpression({ expression, displayMode }: RichMathExpressionProps) {
  const onLayoutCommitted = useContext(MessageTextLayoutContext);
  useLayoutEffect(() => { onLayoutCommitted?.(); });
  return (
    <span
      className={displayMode ? "rich-math-block" : "rich-math-inline"}
      data-expression={expression}
      dangerouslySetInnerHTML={{
        __html: katex.renderToString(expression, {
          displayMode,
          throwOnError: false,
          strict: "ignore",
          trust: false,
        }),
      }}
    />
  );
}

export default RichMathExpression;
