/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class", // Enable class-based dark mode for future use
  theme: {
    extend: {
      colors: {
        // Custom colors matching your current design
        primary: {
          50: "#ebf8ff",
          100: "#bee3f8",
          200: "#90cdf4",
          300: "#63b3ed",
          400: "#4299e1",
          500: "#3182ce", // #3498db equivalent
          600: "#2b77cb",
          700: "#2c5aa0",
          800: "#2a4365",
          900: "#1a365d",
        },
        secondary: {
          50: "#f7fafc",
          100: "#edf2f7",
          200: "#e2e8f0",
          300: "#cbd5e0",
          400: "#a0aec0",
          500: "#718096",
          600: "#4a5568",
          700: "#2d3748",
          800: "#2c3e50", // Original dark blue color
          900: "#1a202c",
        },
        success: {
          400: "#48bb78",
          500: "#38a169", // #2ecc71 equivalent
          600: "#2f855a",
        },
        warning: {
          400: "#ed8936",
          500: "#dd6b20", // #f39c12 equivalent
          600: "#c05621",
        },
        error: {
          400: "#fc8181",
          500: "#e53e3e", // #e74c3c equivalent
          600: "#c53030",
        },
        gray: {
          50: "#f7fafc",
          100: "#edf2f7",
          200: "#e2e8f0",
          300: "#cbd5e0",
          400: "#a0aec0",
          500: "#718096",
          600: "#4a5568",
          700: "#2d3748",
          750: "#1f2937", // Custom shade between 700 and 800 for tab differentiation
          800: "#1a202c",
          900: "#171923",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: ['"Menlo"', '"Consolas"', "monospace"],
      },
      spacing: {
        18: "4.5rem", // 72px for header height
        22: "5.5rem", // 88px for combined header + tabs
      },
      minHeight: {
        300: "300px",
        400: "400px",
        500: "500px",
      },
      maxHeight: {
        300: "300px",
        400: "400px",
        500: "500px",
      },
      height: {
        300: "300px",
        400: "400px",
        500: "500px",
      },
    },
  },
  plugins: [],
};
