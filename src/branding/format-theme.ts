import {
  formatBrandVars,
  type FormatBrandId,
  type FormatBrandVar,
  type FormatThemeMode,
} from 'src/branding/format-brands';

/**
 * The format layer on the document root: the active song's brand as
 * `--format-*` variables and `data-format`. It sits on top of the user's
 * theme (theme-store.ts) and never writes one of its variables, so the grid
 * and its text keep the theme's colours.
 */
export const FORMAT_THEME_VARS: readonly FormatBrandVar[] = ['--format-accent', '--format-accent-ink', '--format-accent-alt'];

export function applyFormatBrand(
  id: FormatBrandId,
  root: HTMLElement = document.documentElement,
  mode: FormatThemeMode = 'dark',
): void {
  for (const [name, value] of Object.entries(formatBrandVars(id, mode))) root.style.setProperty(name, value);
  root.dataset.format = id;
}
