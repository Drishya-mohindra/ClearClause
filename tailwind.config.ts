import type { Config } from 'tailwindcss';

/**
 * Colours are declared as CSS custom properties in `app/globals.css` so light
 * and dark themes share one token set. Every foreground/background pair in the
 * palette meets WCAG 2.1 AA contrast (>= 4.5:1 for body text).
 */
const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'rgb(var(--color-background) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-muted': 'rgb(var(--color-surface-muted) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        foreground: 'rgb(var(--color-foreground) / <alpha-value>)',
        'foreground-muted': 'rgb(var(--color-foreground-muted) / <alpha-value>)',
        primary: 'rgb(var(--color-primary) / <alpha-value>)',
        'primary-foreground': 'rgb(var(--color-primary-foreground) / <alpha-value>)',
        ring: 'rgb(var(--color-ring) / <alpha-value>)',
        critical: 'rgb(var(--color-critical) / <alpha-value>)',
        high: 'rgb(var(--color-high) / <alpha-value>)',
        medium: 'rgb(var(--color-medium) / <alpha-value>)',
        low: 'rgb(var(--color-low) / <alpha-value>)',
        info: 'rgb(var(--color-info) / <alpha-value>)',
        added: 'rgb(var(--color-added) / <alpha-value>)',
        removed: 'rgb(var(--color-removed) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'accordion-down': 'accordion-down 180ms ease-out',
        'accordion-up': 'accordion-up 180ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
