import type { Config } from "tailwindcss";

// Brand palette: Cream #F2E6B3 (page) and Dark Brown #4B2E21 (text, buttons, navigation).
// The gray scale is re-mapped to warm browns and "indigo" (used for links/accents in the pages) to brown,
// so every existing text-gray-* / bg-gray-* / text-indigo-* class follows the palette automatically.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        serif: ['"Iowan Old Style"', '"Palatino Linotype"', "Palatino", "Georgia", "Cambria", "serif"],
      },
      colors: {
        cream: { DEFAULT: "#F2E6B3", light: "#F9F4DD", dark: "#E3D399" },
        brown: { DEFAULT: "#4B2E21", dark: "#3A2218", light: "#6B4636" },
        gray: {
          50: "#FCF9EC", 100: "#EFE3AE", 200: "#E3D399", 300: "#CDBB82", 400: "#7F6755",
          500: "#765B4B", 600: "#5F4435", 700: "#4F3427", 800: "#4B2E21", 900: "#3A2218",
        },
        indigo: { 50: "#F5EDC8", 100: "#EBDDA5", 400: "#8A5A44", 500: "#6B4636", 600: "#4B2E21", 700: "#3A2218" },
      },
      boxShadow: {
        card: "0 1px 2px rgba(75,46,33,.08), 0 6px 18px -8px rgba(75,46,33,.18)",
        lift: "0 2px 4px rgba(75,46,33,.10), 0 14px 28px -12px rgba(75,46,33,.30)",
      },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "none" } },
        "pop-in": { from: { opacity: "0", transform: "scale(.97)" }, to: { opacity: "1", transform: "none" } },
        "tip-in": { from: { opacity: "0" }, to: { opacity: "1" } },
      },
      animation: { "fade-up": "fade-up .3s ease-out both", "pop-in": "pop-in .15s ease-out both", "tip-in": "tip-in .15s ease-out .25s both" },
    },
  },
  plugins: [],
};
export default config;
