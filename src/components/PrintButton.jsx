/**
 * PrintButton — triggers window.print() with a temporary document title.
 * Props:
 *   title — string, temporarily set as document.title while printing
 */
export default function PrintButton({ title }) {
  const handleClick = () => {
    const prev = document.title;
    if (title) document.title = title;
    try {
      window.print();
    } finally {
      // Restore after a tick so the print dialog captures the new title
      setTimeout(() => { document.title = prev; }, 500);
    }
  };
  return (
    <button
      onClick={handleClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        fontSize: 12,
        fontWeight: 600,
        borderRadius: 6,
        border: "1px solid #E2E8F0",
        background: "white",
        color: "var(--text-secondary)",
        cursor: "pointer",
      }}
    >
      <span aria-hidden="true">🖨️</span>
      Print
    </button>
  );
}
