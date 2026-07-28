import React, { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

// @reusable-ui MultiSelectDropdown — USE WHEN: filtering a list by an axis that
//   can take several values at once (owners, states, sessions, tags).
//   INSTEAD OF: a row of toggle chips, or a <select multiple>.
//
// Chips were the first shape of the issue filter bar and read badly: with no
// affordance saying "these are choices" a half-lit row looks like status, not
// like a control, and the row grows without bound as the options do. A closed
// dropdown states the current selection in words and costs one line whatever
// the option count.
//
// Empty selection means "no filter on this axis" — the button then shows
// `allLabel`. Callers that need "empty = nothing matches" should not use this.

export type MultiSelectOption = {
  value: string;
  label: string;
  // Rendered on the right of the row. Count them BEFORE this axis's own
  // selection is applied, or a count drops to zero the moment you deselect it
  // and stops telling you what turning it back on would reveal.
  count?: number;
  // Applied to the option row and, when it is the only thing selected, to the
  // button — this is what carries the owner/state colour coding.
  className?: string;
};

export function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  allLabel,
  className = "",
}: {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  // Close on an outside click or Escape. Escape is captured so it closes the
  // dropdown without also closing the modal this usually sits in.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const chosen = options.filter((o) => selected.includes(o.value));
  // One selection reads as itself; several read as "first +N" so the button
  // width stays put no matter how many are on.
  const summary =
    chosen.length === 0
      ? allLabel
      : chosen.length === 1
        ? chosen[0].label
        : `${chosen[0].label} +${chosen.length - 1}`;

  const toggle = (value: string) =>
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );

  return (
    <div className={`ms-wrap ${className}`} ref={wrapRef}>
      <button
        type="button"
        className={
          "ms-button" +
          (chosen.length ? " has-selection" : "") +
          (chosen.length === 1 && chosen[0].className ? ` ${chosen[0].className}` : "")
        }
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
      >
        <span className="ms-label">{label}</span>
        <span className="ms-summary">{summary}</span>
        <ChevronDown size={13} strokeWidth={2} className="ms-caret" />
      </button>
      {open && (
        <div className="ms-menu" id={listId} role="listbox" aria-multiselectable>
          {options.length === 0 ? (
            <div className="ms-empty">{allLabel}</div>
          ) : (
            options.map((o) => {
              const on = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`ms-option${on ? " on" : ""}${o.className ? ` ${o.className}` : ""}`}
                  onClick={() => toggle(o.value)}
                >
                  <span className="ms-check">
                    {on && <Check size={12} strokeWidth={3} />}
                  </span>
                  <span className="ms-option-label">{o.label}</span>
                  {o.count !== undefined && (
                    <span className="ms-count">{o.count}</span>
                  )}
                </button>
              );
            })
          )}
          {selected.length > 0 && (
            <button
              type="button"
              className="ms-clear"
              onClick={() => onChange([])}
            >
              {allLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
