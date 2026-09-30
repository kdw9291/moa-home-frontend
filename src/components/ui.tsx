import type { ReactNode } from "react";

type Tone = "brand" | "mint" | "warn" | "gray" | "navy";
const TONES: Record<Tone, string> = {
  brand: "bg-brand text-white",
  mint: "bg-mint text-brand-dark",
  warn: "bg-warn-bg text-warn",
  gray: "bg-surface text-muted border border-line",
  navy: "bg-navy text-white",
};

export function Badge({ tone = "gray", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}

export function Notice({ tone = "mint", children }: { tone?: "mint" | "warn"; children: ReactNode }) {
  const cls = tone === "warn" ? "border-amber-300 bg-warn-bg text-warn" : "border-mint-line bg-mint text-brand-dark";
  return <div role="status" className={`rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

export function Unknown({ children = "확인 필요" }: { children?: ReactNode }) {
  return <span className="font-semibold text-warn">{children}</span>;
}
