import { useEffect, useState } from "react";

// Reads/writes theme from <html data-theme="..."> and localStorage.
// Returns [theme, setTheme] where theme ∈ 'light' | 'dark'.
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    if (typeof document !== "undefined") {
      return document.documentElement.dataset.theme || "light";
    }
    return "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("bcc-theme", theme); } catch {}
  }, [theme]);
  return [theme, setTheme];
}

export default function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const isDark = theme === "dark";
  const toggle = () => setTheme(isDark ? "light" : "dark");
  return (
    <button
      onClick={toggle}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
      style={{
        background: "transparent",
        border: "1px solid rgba(148, 163, 184, 0.4)",
        color: "#F1F5F9",
        borderRadius: "50%",
        width: 30, height: 30,
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "background 0.15s, border-color 0.15s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(148, 163, 184, 0.15)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      {isDark ? (
        // Sun icon
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"></circle>
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>
        </svg>
      ) : (
        // Moon icon
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
      )}
    </button>
  );
}
