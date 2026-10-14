import { useMemo } from "react";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Pretty JSON with light syntax colouring. */
export function Json({ value }: { value: unknown }) {
  const html = useMemo(() => {
    let text: string;
    try {
      text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
    if (text === undefined) text = "undefined";
    return escape(text).replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (m, str, colon, bool, num) => {
        if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
        if (bool) return `<span class="b">${bool}</span>`;
        if (num) return `<span class="n">${num}</span>`;
        return m;
      },
    );
  }, [value]);
  return <pre className="json" dangerouslySetInnerHTML={{ __html: html }} />;
}
