import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { AccountMenu, AccountProviders } from "@/components/AccountUI";
import { SwRegister } from "@/components/SwRegister";
import "./globals.css";

export const metadata: Metadata = {
  title: "모아홈 — 청약 공고 탐색",
  description: "청약홈 공고를 지역·예산·전용면적으로 살펴보고 출처와 확인일을 함께 확인합니다.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
  appleWebApp: { capable: true, title: "모아홈", statusBarStyle: "default" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className="sticky top-0 z-20 border-b border-line bg-white/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
            <Link href="/" className="text-xl font-extrabold tracking-tight text-brand">모아홈</Link>
            <nav aria-label="주 메뉴" className="flex items-center gap-1 text-sm">
              <Link href="/" className="rounded-md border-b-2 border-brand px-3 py-2 font-semibold text-brand" aria-current="page">청약 공고</Link>
              <span className="rounded-md px-3 py-2 text-muted" title="준비 중">
                미분양·줍줍 <span className="ml-1 rounded bg-surface px-1.5 py-0.5 text-[11px]">준비 중</span>
              </span>
            </nav>
            <AccountMenu />
          </div>
        </header>
        <AccountProviders />
        <SwRegister />
        <main className="mx-auto max-w-6xl px-4 pb-16 pt-4">{children}</main>
        <footer className="border-t border-line bg-white">
          <p className="mx-auto max-w-6xl px-4 py-4 text-xs leading-relaxed text-muted">
            이 서비스의 정보는 청약홈(공공데이터포털) 공고를 바탕으로 한 참고용이며 실제 공고와 다를 수 있습니다.
            검색 조건에 맞는 것과 실제 청약 자격은 다릅니다. 신청 전 반드시 공식 모집공고문을 확인하세요.
          </p>
        </footer>
      </body>
    </html>
  );
}
