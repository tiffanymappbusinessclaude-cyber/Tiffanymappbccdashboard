import { useState, useEffect, useRef } from "react";

/**
 * ConfirmDeleteButton — two-click delete confirmation pattern.
 * First click arms the button (shows confirmLabel). Second click within
 * 4 seconds fires onConfirm. Disarms automatically on blur or timeout.
 *
 * Props:
 *   onConfirm    — called when user clicks the armed button
 *   label        — initial button label (default: "Delete")
 *   confirmLabel — armed-state label (default: "Click again to confirm")
 *   disabled     — boolean
 */
export default function ConfirmDeleteButton({
  onConfirm,
  label = "Delete",
  confirmLabel = "Click again to confirm",
  disabled = false,
}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleClick = () => {
    if (disabled) return;
    if (!armed) {
      setArmed(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setArmed(false), 4000);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      setArmed(false);
      onConfirm?.();
    }
  };

  return (
    <button
      onClick={handleClick}
      onBlur={() => setArmed(false)}
      disabled={disabled}
      style={{
        padding: "6px 14px",
        fontSize: 12,
        fontWeight: 600,
        borderRadius: 6,
        border: armed ? "1px solid #B91C1C" : "1px solid #FCA5A5",
        background: armed ? "var(--danger)" : "white",
        color: armed ? "white" : "var(--danger)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
