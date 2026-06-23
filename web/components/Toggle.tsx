import React from "react";

// A small on/off switch — a visually-hidden real checkbox (so label htmlFor,
// keyboard focus, and form semantics keep working) wrapped in a styled track +
// thumb. Used in the settings modal and the board settings panel in place of
// bare checkboxes.
export function Toggle({
  checked,
  onChange,
  id,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <span className={"toggle" + (disabled ? " is-disabled" : "")}>
      <input
        type="checkbox"
        id={id}
        className="toggle-input"
        role="switch"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
    </span>
  );
}
