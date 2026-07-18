/**
 * Tailwind config — Sunshine State Insurance BCC
 *
 * The `if-*` palette originates from Imaginary Farms' demo theme. the agent's BCC
 * is navy-branded, so this file rebinds every if-* token to the agent's palette.
 *
 * v2 (2026-07-17): Tokens now resolve to CSS custom properties defined in
 * src/styles/theme.css, which switches values between light and dark modes.
 * The `rgb(var(--if-x-rgb) / <alpha-value>)` pattern preserves Tailwind's
 * slash-opacity modifiers (e.g. `bg-if-navy/30`) — the alpha value is
 * substituted by Tailwind's JIT at build time.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./BCCApp.jsx",
    "./src/**/*.{js,jsx}",
    "./premium-patches/**/*.{js,jsx}"
  ],
  theme: {
    extend: {
      colors: {
        "if-navy":       "rgb(var(--if-navy-rgb) / <alpha-value>)",
        "if-navy-lt":    "rgb(var(--if-navy-lt-rgb) / <alpha-value>)",
        "if-ink":        "rgb(var(--if-ink-rgb) / <alpha-value>)",
        "if-muted":      "rgb(var(--if-muted-rgb) / <alpha-value>)",
        "if-line":       "rgb(var(--if-line-rgb) / <alpha-value>)",
        "if-teal":       "rgb(var(--if-teal-rgb) / <alpha-value>)",
        "if-teal-lt":    "rgb(var(--if-teal-lt-rgb) / <alpha-value>)",
        "if-surface":    "rgb(var(--if-surface-rgb) / <alpha-value>)",
        "if-page":       "rgb(var(--if-page-rgb) / <alpha-value>)",
        "if-blue":       "rgb(var(--if-blue-rgb) / <alpha-value>)",
        "if-blue-lt":    "rgb(var(--if-blue-lt-rgb) / <alpha-value>)",
        "if-cream":      "rgb(var(--if-cream-rgb) / <alpha-value>)",
        "if-success":    "rgb(var(--if-success-rgb) / <alpha-value>)",
        "if-success-lt": "rgb(var(--if-success-lt-rgb) / <alpha-value>)",
        "if-danger":     "rgb(var(--if-danger-rgb) / <alpha-value>)",
        "if-danger-lt":  "rgb(var(--if-danger-lt-rgb) / <alpha-value>)",
        "if-warn":       "rgb(var(--if-warn-rgb) / <alpha-value>)",
        "if-warn-lt":    "rgb(var(--if-warn-lt-rgb) / <alpha-value>)",
      },
      fontFamily: {
        sans: [
          "Inter Variable", "Inter",
          "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto",
          '"Helvetica Neue"', "Arial", "sans-serif"
        ],
      },
    },
  },
  plugins: [],
};
