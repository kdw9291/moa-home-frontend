"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { areaChipLabel, budgetChipLabel } from "@/lib/chips";
import { resolveConflict } from "@/store/account";
import { usePrefs } from "@/store/prefs";
import { useSession } from "@/store/session";
import type { Filters } from "@/lib/types";

/** 앱 시작 시 한 번 세션을 초기화하고 로그인·필터 충돌 대화상자를 전역으로 띄운다. */
export function AccountProviders() {
  const init = useSession((s) => s.init);
  useEffect(() => init(), [init]);
  return (
    <>
      <LoginDialog />
      <ConflictDialog />
    </>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(ref.current?.querySelectorAll<HTMLElement>("input,button,a[href],select,textarea,[tabindex]:not([tabindex='-1'])") ?? []).filter((el) => !el.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose?.();
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) return e.preventDefault();
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.(); // 닫으면 대화상자를 연 컨트롤로 포커스를 돌려준다
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function LoginDialog() {
  const open = useSession((s) => s.loginOpen);
  const reason = useSession((s) => s.loginReason);
  const close = useSession((s) => s.closeLogin);
  const send = useSession((s) => s.sendMagicLink);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      setMsg(null);
      setBusy(false);
    }
  }, [open]);
  if (!open) return null;
  return (
    <Modal title="로그인" onClose={close}>
      <p className="mt-1 text-sm text-muted">{reason ?? "이메일로 로그인 링크를 보내 드립니다. 비밀번호는 필요 없습니다."}</p>
      <form
        className="mt-4 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await send(email);
          setMsg({ ok: r.ok, text: r.message });
          setBusy(false);
        }}
      >
        <label className="block text-sm">
          <span className="sr-only">이메일</span>
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="이메일 주소" className="w-full rounded-lg border border-line px-3 py-2.5" />
        </label>
        <button type="submit" disabled={busy} className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60">
          {busy ? "보내는 중…" : "로그인 링크 보내기"}
        </button>
        {msg && <p role="status" className={`text-sm ${msg.ok ? "text-brand-dark" : "text-warn"}`}>{msg.text}</p>}
        <button type="button" onClick={close} className="w-full text-sm text-muted underline">닫기</button>
      </form>
    </Modal>
  );
}

function describe(f: Filters): string {
  const parts = [budgetChipLabel(f), areaChipLabel(f), f.regionCodes.length ? `지역 ${f.regionCodes.length}곳` : null, f.families.length ? `유형 ${f.families.length}개` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "조건 없음";
}

function ConflictDialog() {
  const conflict = usePrefs((s) => s.conflict);
  const [busy, setBusy] = useState(false);
  if (!conflict) return null;
  const choose = async (c: "local" | "server") => {
    setBusy(true);
    await resolveConflict(c);
    setBusy(false);
  };
  return (
    <Modal title="어느 검색 조건을 사용할까요?">
      <p className="mt-1 text-sm text-muted">이 브라우저에 저장된 조건과 계정에 저장된 조건이 다릅니다. 선택한 조건이 계정에 저장되고 다른 조건은 사용되지 않습니다.</p>
      <div className="mt-4 space-y-2 text-sm">
        <button disabled={busy} onClick={() => void choose("server")} className="w-full rounded-lg border border-line p-3 text-left hover:border-brand">
          <strong>계정에 저장된 조건</strong><br /><span className="text-muted">{describe(conflict.server)}</span>
        </button>
        <button disabled={busy} onClick={() => void choose("local")} className="w-full rounded-lg border border-line p-3 text-left hover:border-brand">
          <strong>이 브라우저의 조건</strong><br /><span className="text-muted">{describe(conflict.local)}</span>
        </button>
      </div>
    </Modal>
  );
}

export function AccountMenu() {
  const { ready, user, openLogin, signOut, pushWarning, dismissPushWarning } = useSession();
  const [busy, setBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const uid = user?.id ?? null;
  useEffect(() => setSignOutError(null), [uid]); // 계정이 바뀌면 이전 계정의 로그아웃 오류·강제 로그아웃 버튼을 없앤다
  if (!ready) return <span className="h-8 w-16" aria-hidden />;
  if (!user) {
    return <button onClick={() => openLogin()} className="rounded-md border border-line px-3 py-1.5 text-sm font-semibold text-brand">로그인</button>;
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <Link href="/bookmarks/" className="rounded-md px-2 py-1.5 font-semibold text-brand hover:bg-mint">관심 공고</Link>
      <span className="hidden max-w-[10rem] truncate text-xs text-muted sm:inline" title={user.email ?? ""}>{user.email}</span>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setSignOutError(await signOut());
          setBusy(false);
        }}
        className="rounded-md border border-line px-2.5 py-1.5 text-xs text-muted"
      >
        로그아웃
      </button>
      {pushWarning && (
        <div role="alert" className="absolute right-4 top-14 z-30 w-72 rounded-lg border border-amber-300 bg-warn-bg p-3 text-xs text-warn shadow">
          <p>계정이 바뀌는 동안 이 기기의 이전 계정 알림 구독을 해제하지 못했습니다. 이 기기에서 이전 계정의 알림이 계속 올 수 있으니 브라우저 설정에서 이 사이트의 알림을 꺼 주세요.</p>
          <button className="mt-2 rounded border border-amber-400 px-2 py-1 font-semibold" onClick={dismissPushWarning}>확인</button>
        </div>
      )}
      {signOutError && (
        <div role="alert" className="absolute right-4 top-14 z-30 w-72 rounded-lg border border-amber-300 bg-warn-bg p-3 text-xs text-warn shadow">
          <p>{signOutError}</p>
          <button
            className="mt-2 rounded border border-amber-400 px-2 py-1 font-semibold"
            onClick={async () => {
              setBusy(true);
              setSignOutError(await signOut(true));
              setBusy(false);
            }}
          >
            그래도 로그아웃
          </button>
        </div>
      )}
    </div>
  );
}

export function BookmarkButton({ announcementId, name }: { announcementId: string; name: string }) {
  const { ready, user, bookmarkIds, toggleBookmark, openLogin } = useSession();
  const [err, setErr] = useState<string | null>(null);
  const on = bookmarkIds.has(announcementId);
  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        aria-pressed={on}
        aria-label={`${name} ${on ? "관심 공고에서 제거" : "관심 공고에 저장"}`}
        disabled={!ready}
        onClick={async () => {
          if (!user) return openLogin("관심 공고를 저장하고 접수일 알림을 받으려면 로그인해 주세요.");
          setErr(null);
          setErr(await toggleBookmark(announcementId));
        }}
        className={`rounded-full border px-3 py-1 text-xs font-semibold ${on ? "border-brand bg-brand text-white" : "border-line bg-white text-muted hover:border-brand"}`}
      >
        {on ? "♥ 관심 저장됨" : "♡ 관심 저장"}
      </button>
      {err && <span role="alert" className="mt-1 text-xs text-warn">{err}</span>}
    </span>
  );
}
