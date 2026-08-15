import katex from "katex";
import "katex/dist/katex.min.css";

interface RichMathExpressionProps {
  expression: string;
  displayMode: boolean;
}

function RichMathExpression({ expression, displayMode }: RichMathExpressionProps) {
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
