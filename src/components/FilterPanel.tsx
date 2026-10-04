"use client";
import { useEffect, useState } from "react";
import { DEFAULT_FILTERS } from "@/lib/feed";
import { eokToKrw } from "@/lib/money";
import { activePreset, AREA_PRESETS, type AreaPresetKey } from "@/lib/presets";
import { FAMILY_LABEL } from "@/lib/labels";
import { parseAreaInput, sqmToPyeong } from "@/lib/units";
import type { Family, Filters } from "@/lib/types";
import { usePrefs } from "@/store/prefs";

const BUDGET_OPTIONS = [3, 4, 5, 6, 8, 10, 15];

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-line py-4 first:border-t-0">
      <legend className="float-left mb-2 w-full text-sm font-bold">
        {title} {hint && <span className="ml-1 text-xs font-normal text-muted">{hint}</span>}
      </legend>
      <div className="clear-both">{children}</div>
    </fieldset>
  );
}

/** 평/㎡ 직접 입력. 입력값은 확정(blur/Enter) 시에만 ㎡ 정규값으로 한 번 환산해 저장한다. */
function AreaInput({ label, sqm, unit, onCommit }: { label: string; sqm: number | null; unit: Filters["areaUnit"]; onCommit: (sqm: number | null) => void }) {
  const shown = sqm === null ? "" : unit === "pyeong" ? sqmToPyeong(sqm).toFixed(1) : String(sqm);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const r = parseAreaInput(text, shown, unit);
    if (r.kind === "invalid") return setText(shown);
    if (r.kind === "commit") onCommit(r.sqm);
  };
  return (
    <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
      {label}
      <div className="flex items-center gap-1">
        <input
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className="w-full rounded-md border border-line bg-white px-2 py-1.5 text-sm text-navy"
          placeholder="제한 없음"
        />
        <span className="text-sm text-navy">{unit === "pyeong" ? "평" : "㎡"}</span>
      </div>
    </label>
  );
}

export function UnitToggle() {
  const unit = usePrefs((s) => s.filters.areaUnit);
  const setAreaUnit = usePrefs((s) => s.setAreaUnit);
  return (
    <div role="group" aria-label="면적 표시 단위" className="inline-flex overflow-hidden rounded-md border border-line text-xs">
      {(["sqm", "pyeong"] as const).map((u) => (
        <button
          key={u}
          type="button"
          aria-pressed={unit === u}
          onClick={() => setAreaUnit(u)}
          className={`px-2.5 py-1 font-semibold ${unit === u ? "bg-brand text-white" : "bg-white text-muted"}`}
        >
          {u === "sqm" ? "㎡" : "평"}
        </button>
      ))}
    </div>
  );
}

export function FilterPanel({ regions }: { regions: { code: string; name: string }[] }) {
  const filters = usePrefs((s) => s.filters);
  const setFilters = usePrefs((s) => s.setFilters);
  const resetFilters = usePrefs((s) => s.resetFilters);
  const preset = activePreset(filters);
  const budgetEok = filters.budgetMaxKrw === null ? "" : String(filters.budgetMaxKrw / 100_000_000);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const dirty = JSON.stringify({ ...filters, areaUnit: "" }) !== JSON.stringify({ ...DEFAULT_FILTERS, areaUnit: "" });

  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-base font-bold">상세 조건으로 찾기</h2>
        <button type="button" onClick={resetFilters} disabled={!dirty} className="text-xs text-muted underline disabled:no-underline disabled:opacity-40">
          초기화
        </button>
      </div>

      <Section title="지역" hint="원천 공급지역 기준">
        {regions.length === 0 ? (
          <p className="text-xs text-muted">불러온 공고가 없어 선택지가 없습니다.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {regions.map((r) => (
              <label key={r.code} className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${filters.regionCodes.includes(r.code) ? "border-brand bg-mint font-semibold text-brand-dark" : "border-line text-muted"}`}>
                <input type="checkbox" className="sr-only" checked={filters.regionCodes.includes(r.code)} onChange={() => setFilters({ regionCodes: toggle(filters.regionCodes, r.code) })} />
                {r.name}
              </label>
            ))}
          </div>
        )}
      </Section>

      <Section title="분양가" hint="주택형 최고 분양가 기준">
        <div className="flex items-center gap-2">
          <select
            aria-label="예산 상한(억원)"
            value={BUDGET_OPTIONS.map(String).includes(budgetEok) ? budgetEok : budgetEok === "" ? "" : "custom"}
            onChange={(e) => e.target.value === "" ? setFilters({ budgetMaxKrw: null }) : e.target.value !== "custom" && setFilters({ budgetMaxKrw: eokToKrw(Number(e.target.value)) })}
            className="w-full rounded-md border border-line bg-white px-2 py-1.5 text-sm"
          >
            <option value="">상한 없음</option>
            {BUDGET_OPTIONS.map((b) => <option key={b} value={b}>{b}억원 이하</option>)}
            {budgetEok !== "" && !BUDGET_OPTIONS.map(String).includes(budgetEok) && <option value="custom">{budgetEok}억원 이하</option>}
          </select>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          최고가가 상한 이하인 주택형만 충족으로 봅니다. 최고가가 넘으면 더 저렴한 세대가 있을 수 있어 &lsquo;판정 미확인&rsquo;으로 따로 보여 드립니다.
        </p>
      </Section>

      <Section title="전용면적">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-muted">표시 단위</span>
          <UnitToggle />
        </div>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(AREA_PRESETS) as AreaPresetKey[]).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={preset === k}
              onClick={() => setFilters(preset === k ? { minAreaSqm: null, maxAreaSqm: null, minAreaInclusive: true, maxAreaInclusive: true } : AREA_PRESETS[k].range)}
              className={`rounded-full border px-3 py-1 text-xs ${preset === k ? "border-brand bg-mint font-semibold text-brand-dark" : "border-line text-muted"}`}
            >
              {AREA_PRESETS[k].label}
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <AreaInput label="최소" sqm={filters.minAreaSqm} unit={filters.areaUnit} onCommit={(v) => setFilters({ minAreaSqm: v, minAreaInclusive: true })} />
          <AreaInput label="최대" sqm={filters.maxAreaSqm} unit={filters.areaUnit} onCommit={(v) => setFilters({ maxAreaSqm: v, maxAreaInclusive: true })} />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          전용면적으로만 찾습니다. APT·잔여세대는 공급면적만 제공되어 전용면적을 알 수 없으므로 &lsquo;판정 미확인&rsquo;으로 나뉩니다. 1평 ≈ 3.305785㎡. ㎡/평 전환은 화면 표시(전용·공급면적, 공고 카드·상세)만 바꾸며, 평 표시는 반올림 값이고 검색 기준은 ㎡입니다.
        </p>
      </Section>

      <Section title="공급 유형" hint="원천 API 계열">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(FAMILY_LABEL) as Family[]).map((fam) => (
            <label key={fam} className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${filters.families.includes(fam) ? "border-brand bg-mint font-semibold text-brand-dark" : "border-line text-muted"}`}>
              <input type="checkbox" className="sr-only" checked={filters.families.includes(fam)} onChange={() => setFilters({ families: toggle(filters.families, fam) })} />
              {FAMILY_LABEL[fam]}
            </label>
          ))}
        </div>
      </Section>
    </div>
  );
}
