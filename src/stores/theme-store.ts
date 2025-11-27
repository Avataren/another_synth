import { defineStore } from 'pinia';
import { ref, watch, computed } from 'vue';
import { useUserSettingsStore } from './user-settings-store';

// Monospace fonts for tracker matrix
export const monospaceFonts = [
  { id: 'JetBrains Mono', name: 'JetBrains Mono', googleFont: 'JetBrains+Mono:wght@400;500;600;700;800' },
  { id: 'Fira Code', name: 'Fira Code', googleFont: 'Fira+Code:wght@400;500;600;700' },
  { id: 'Source Code Pro', name: 'Source Code Pro', googleFont: 'Source+Code+Pro:wght@400;500;600;700' },
  { id: 'IBM Plex Mono', name: 'IBM Plex Mono', googleFont: 'IBM+Plex+Mono:wght@400;500;600;700' },
  { id: 'Roboto Mono', name: 'Roboto Mono', googleFont: 'Roboto+Mono:wght@400;500;600;700' },
  { id: 'Space Mono', name: 'Space Mono', googleFont: 'Space+Mono:wght@400;700' },
  { id: 'Inconsolata', name: 'Inconsolata', googleFont: 'Inconsolata:wght@400;500;600;700' },
  { id: 'Ubuntu Mono', name: 'Ubuntu Mono', googleFont: 'Ubuntu+Mono:wght@400;700' },
  { id: 'Anonymous Pro', name: 'Anonymous Pro', googleFont: 'Anonymous+Pro:wght@400;700' },
  { id: 'Cousine', name: 'Cousine', googleFont: 'Cousine:wght@400;700' }
];

// UI fonts for general text
export const uiFonts = [
  { id: 'Inter', name: 'Inter', googleFont: 'Inter:wght@400;500;600;700' },
  { id: 'Roboto', name: 'Roboto', googleFont: 'Roboto:wght@400;500;700' },
  { id: 'Open Sans', name: 'Open Sans', googleFont: 'Open+Sans:wght@400;500;600;700' },
  { id: 'Lato', name: 'Lato', googleFont: 'Lato:wght@400;700' },
  { id: 'Poppins', name: 'Poppins', googleFont: 'Poppins:wght@400;500;600;700' },
  { id: 'Nunito', name: 'Nunito', googleFont: 'Nunito:wght@400;500;600;700' },
  { id: 'Work Sans', name: 'Work Sans', googleFont: 'Work+Sans:wght@400;500;600;700' },
  { id: 'DM Sans', name: 'DM Sans', googleFont: 'DM+Sans:wght@400;500;600;700' },
  { id: 'Outfit', name: 'Outfit', googleFont: 'Outfit:wght@400;500;600;700' },
  { id: 'Manrope', name: 'Manrope', googleFont: 'Manrope:wght@400;500;600;700' }
];

export interface ThemeColors {
  // App-wide colors
  appBackground: string;
  appBackgroundAlt: string;
  headerBackground: string;
  panelBackground: string;
  panelBackgroundAlt: string;
  panelBorder: string;

  // Text colors
  textPrimary: string;
  textSecondary: string;
  textMuted: string;

  // Interactive elements
  buttonBackground: string;
  buttonBackgroundHover: string;
  inputBackground: string;
  inputBorder: string;

  // Tracker entry backgrounds
  entryBase: string;
  entryFilled: string;
  entryFilledAlt: string;
  entryRowSub: string;
  entryRowBeat: string;
  entryRowBar: string;

  // Entry borders
  borderDefault: string;
  borderHover: string;
  borderBeat: string;
  borderBar: string;

  // Active/selection colors
  accentPrimary: string;
  accentSecondary: string;
  activeBackground: string;
  activeBorder: string;
  selectedBorder: string;
  selectedBackground: string;
  cellActiveBg: string;
  cellActiveText: string;

  // Cell text colors
  noteText: string;
  instrumentText: string;
  volumeText: string;
  effectText: string;
  defaultText: string;
}

export interface TrackerTheme {
  id: string;
  name: string;
  description: string;
  colors: ThemeColors;
}

const CUSTOM_THEME_STORAGE_KEY = 'synth-custom-theme';

export const themePresets: TrackerTheme[] = [
  {
    id: 'default',
    name: 'Cyan Wave',
    description: 'Default cyan and teal theme',
    colors: {
      appBackground: '#0b111a',
      appBackgroundAlt: '#0d1420',
      headerBackground: '#0a0f18',
      panelBackground: '#0f1621',
      panelBackgroundAlt: '#121a28',
      panelBorder: 'rgba(255, 255, 255, 0.06)',
      textPrimary: '#e8f3ff',
      textSecondary: '#c8d9f2',
      textMuted: '#9fb3d3',
      buttonBackground: 'rgba(77, 242, 197, 0.1)',
      buttonBackgroundHover: 'rgba(77, 242, 197, 0.18)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(255, 255, 255, 0.1)',
      entryBase: 'rgba(13, 18, 29, 0.85)',
      entryFilled: 'rgba(21, 31, 48, 0.95)',
      entryFilledAlt: 'rgba(17, 24, 38, 0.95)',
      entryRowSub: 'rgba(13, 18, 29, 0.9)',
      entryRowBeat: 'rgba(18, 24, 37, 0.95)',
      entryRowBar: 'rgba(20, 28, 44, 0.98)',
      borderDefault: 'rgba(255, 255, 255, 0.05)',
      borderHover: 'rgba(255, 255, 255, 0.12)',
      borderBeat: 'rgba(255, 255, 255, 0.08)',
      borderBar: 'rgba(77, 242, 197, 0.35)',
      accentPrimary: 'rgb(77, 242, 197)',
      accentSecondary: 'rgb(88, 176, 255)',
      activeBackground: 'rgba(77, 242, 197, 0.08)',
      activeBorder: 'rgb(77, 242, 197)',
      selectedBorder: 'rgba(77, 242, 197, 0.9)',
      selectedBackground: 'rgba(77, 242, 197, 0.12)',
      cellActiveBg: 'linear-gradient(90deg, rgba(77, 242, 197, 0.9), rgba(88, 176, 255, 0.9))',
      cellActiveText: '#0c1624',
      noteText: '#ffffff',
      instrumentText: 'rgba(255, 255, 255, 0.82)',
      volumeText: '#85b7ff',
      effectText: '#8ef5c5',
      defaultText: '#d8e7ff'
    }
  },
  {
    id: 'amber',
    name: 'Amber Glow',
    description: 'Warm amber and orange theme',
    colors: {
      appBackground: '#12100a',
      appBackgroundAlt: '#18140c',
      headerBackground: '#0f0d08',
      panelBackground: '#1a1610',
      panelBackgroundAlt: '#201a12',
      panelBorder: 'rgba(255, 200, 100, 0.08)',
      textPrimary: '#fff5e8',
      textSecondary: '#ffe8c8',
      textMuted: '#c8a878',
      buttonBackground: 'rgba(255, 180, 80, 0.12)',
      buttonBackgroundHover: 'rgba(255, 180, 80, 0.2)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(255, 200, 100, 0.15)',
      entryBase: 'rgba(20, 15, 10, 0.85)',
      entryFilled: 'rgba(30, 24, 18, 0.95)',
      entryFilledAlt: 'rgba(26, 20, 15, 0.95)',
      entryRowSub: 'rgba(20, 15, 10, 0.9)',
      entryRowBeat: 'rgba(26, 20, 15, 0.95)',
      entryRowBar: 'rgba(32, 25, 18, 0.98)',
      borderDefault: 'rgba(255, 200, 100, 0.08)',
      borderHover: 'rgba(255, 200, 100, 0.15)',
      borderBeat: 'rgba(255, 200, 100, 0.12)',
      borderBar: 'rgba(255, 180, 80, 0.4)',
      accentPrimary: 'rgb(255, 180, 80)',
      accentSecondary: 'rgb(255, 140, 60)',
      activeBackground: 'rgba(255, 180, 80, 0.12)',
      activeBorder: 'rgb(255, 180, 80)',
      selectedBorder: 'rgba(255, 180, 80, 0.9)',
      selectedBackground: 'rgba(255, 180, 80, 0.15)',
      cellActiveBg: 'linear-gradient(90deg, rgba(255, 180, 80, 0.9), rgba(255, 140, 60, 0.9))',
      cellActiveText: '#1a0f08',
      noteText: '#fff5e8',
      instrumentText: 'rgba(255, 245, 232, 0.82)',
      volumeText: '#ffca80',
      effectText: '#ffa850',
      defaultText: '#ffe8c8'
    }
  },
  {
    id: 'purple',
    name: 'Purple Haze',
    description: 'Deep purple and magenta theme',
    colors: {
      appBackground: '#100a18',
      appBackgroundAlt: '#140c20',
      headerBackground: '#0c0814',
      panelBackground: '#16101f',
      panelBackgroundAlt: '#1c1428',
      panelBorder: 'rgba(200, 150, 255, 0.08)',
      textPrimary: '#f5e8ff',
      textSecondary: '#e8d0ff',
      textMuted: '#a888c8',
      buttonBackground: 'rgba(180, 120, 255, 0.12)',
      buttonBackgroundHover: 'rgba(180, 120, 255, 0.2)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(200, 150, 255, 0.15)',
      entryBase: 'rgba(18, 10, 25, 0.85)',
      entryFilled: 'rgba(28, 18, 38, 0.95)',
      entryFilledAlt: 'rgba(24, 15, 32, 0.95)',
      entryRowSub: 'rgba(18, 10, 25, 0.9)',
      entryRowBeat: 'rgba(24, 15, 32, 0.95)',
      entryRowBar: 'rgba(30, 20, 40, 0.98)',
      borderDefault: 'rgba(200, 150, 255, 0.08)',
      borderHover: 'rgba(200, 150, 255, 0.15)',
      borderBeat: 'rgba(200, 150, 255, 0.12)',
      borderBar: 'rgba(180, 120, 255, 0.4)',
      accentPrimary: 'rgb(180, 120, 255)',
      accentSecondary: 'rgb(220, 80, 255)',
      activeBackground: 'rgba(180, 120, 255, 0.12)',
      activeBorder: 'rgb(180, 120, 255)',
      selectedBorder: 'rgba(180, 120, 255, 0.9)',
      selectedBackground: 'rgba(180, 120, 255, 0.15)',
      cellActiveBg: 'linear-gradient(90deg, rgba(180, 120, 255, 0.9), rgba(220, 80, 255, 0.9))',
      cellActiveText: '#120820',
      noteText: '#f5e8ff',
      instrumentText: 'rgba(245, 232, 255, 0.82)',
      volumeText: '#c896ff',
      effectText: '#dc50ff',
      defaultText: '#e8d0ff'
    }
  },
  {
    id: 'green',
    name: 'Matrix Green',
    description: 'Classic green terminal theme',
    colors: {
      appBackground: '#060e06',
      appBackgroundAlt: '#081208',
      headerBackground: '#040a04',
      panelBackground: '#0a140a',
      panelBackgroundAlt: '#0e1a0e',
      panelBorder: 'rgba(100, 255, 100, 0.08)',
      textPrimary: '#e8ffe8',
      textSecondary: '#d0ffd0',
      textMuted: '#80c080',
      buttonBackground: 'rgba(80, 255, 80, 0.12)',
      buttonBackgroundHover: 'rgba(80, 255, 80, 0.2)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(100, 255, 100, 0.15)',
      entryBase: 'rgba(8, 18, 8, 0.85)',
      entryFilled: 'rgba(12, 28, 12, 0.95)',
      entryFilledAlt: 'rgba(10, 22, 10, 0.95)',
      entryRowSub: 'rgba(8, 18, 8, 0.9)',
      entryRowBeat: 'rgba(12, 24, 12, 0.95)',
      entryRowBar: 'rgba(15, 30, 15, 0.98)',
      borderDefault: 'rgba(100, 255, 100, 0.08)',
      borderHover: 'rgba(100, 255, 100, 0.15)',
      borderBeat: 'rgba(100, 255, 100, 0.12)',
      borderBar: 'rgba(80, 255, 80, 0.4)',
      accentPrimary: 'rgb(80, 255, 80)',
      accentSecondary: 'rgb(120, 255, 120)',
      activeBackground: 'rgba(80, 255, 80, 0.12)',
      activeBorder: 'rgb(80, 255, 80)',
      selectedBorder: 'rgba(80, 255, 80, 0.9)',
      selectedBackground: 'rgba(80, 255, 80, 0.15)',
      cellActiveBg: 'linear-gradient(90deg, rgba(80, 255, 80, 0.9), rgba(120, 255, 120, 0.9))',
      cellActiveText: '#081808',
      noteText: '#e8ffe8',
      instrumentText: 'rgba(232, 255, 232, 0.82)',
      volumeText: '#a0ffa0',
      effectText: '#80ff80',
      defaultText: '#d0ffd0'
    }
  },
  {
    id: 'monochrome',
    name: 'Monochrome',
    description: 'Classic black and white theme',
    colors: {
      appBackground: '#0a0a0a',
      appBackgroundAlt: '#0e0e0e',
      headerBackground: '#080808',
      panelBackground: '#121212',
      panelBackgroundAlt: '#181818',
      panelBorder: 'rgba(255, 255, 255, 0.08)',
      textPrimary: '#ffffff',
      textSecondary: '#e8e8e8',
      textMuted: '#a0a0a0',
      buttonBackground: 'rgba(255, 255, 255, 0.1)',
      buttonBackgroundHover: 'rgba(255, 255, 255, 0.18)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(255, 255, 255, 0.15)',
      entryBase: 'rgba(10, 10, 10, 0.85)',
      entryFilled: 'rgba(20, 20, 20, 0.95)',
      entryFilledAlt: 'rgba(16, 16, 16, 0.95)',
      entryRowSub: 'rgba(10, 10, 10, 0.9)',
      entryRowBeat: 'rgba(18, 18, 18, 0.95)',
      entryRowBar: 'rgba(24, 24, 24, 0.98)',
      borderDefault: 'rgba(255, 255, 255, 0.08)',
      borderHover: 'rgba(255, 255, 255, 0.15)',
      borderBeat: 'rgba(255, 255, 255, 0.12)',
      borderBar: 'rgba(255, 255, 255, 0.35)',
      accentPrimary: 'rgb(255, 255, 255)',
      accentSecondary: 'rgb(220, 220, 220)',
      activeBackground: 'rgba(255, 255, 255, 0.12)',
      activeBorder: 'rgb(255, 255, 255)',
      selectedBorder: 'rgba(255, 255, 255, 0.9)',
      selectedBackground: 'rgba(255, 255, 255, 0.15)',
      cellActiveBg: 'linear-gradient(90deg, rgba(255, 255, 255, 0.9), rgba(220, 220, 220, 0.9))',
      cellActiveText: '#0a0a0a',
      noteText: '#ffffff',
      instrumentText: 'rgba(255, 255, 255, 0.82)',
      volumeText: '#d0d0d0',
      effectText: '#c0c0c0',
      defaultText: '#e8e8e8'
    }
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    description: 'Retro 80s neon vibes',
    colors: {
      appBackground: '#0c0418',
      appBackgroundAlt: '#10061e',
      headerBackground: '#080312',
      panelBackground: '#140820',
      panelBackgroundAlt: '#1a0c28',
      panelBorder: 'rgba(255, 100, 200, 0.1)',
      textPrimary: '#fff0f8',
      textSecondary: '#f0d0e8',
      textMuted: '#a080a8',
      buttonBackground: 'rgba(255, 50, 150, 0.15)',
      buttonBackgroundHover: 'rgba(255, 50, 150, 0.25)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(255, 100, 200, 0.2)',
      entryBase: 'rgba(15, 5, 25, 0.85)',
      entryFilled: 'rgba(25, 10, 40, 0.95)',
      entryFilledAlt: 'rgba(20, 8, 35, 0.95)',
      entryRowSub: 'rgba(15, 5, 25, 0.9)',
      entryRowBeat: 'rgba(22, 8, 38, 0.95)',
      entryRowBar: 'rgba(30, 12, 50, 0.98)',
      borderDefault: 'rgba(255, 100, 200, 0.08)',
      borderHover: 'rgba(255, 100, 200, 0.18)',
      borderBeat: 'rgba(255, 100, 200, 0.12)',
      borderBar: 'rgba(255, 50, 150, 0.5)',
      accentPrimary: 'rgb(255, 50, 150)',
      accentSecondary: 'rgb(50, 200, 255)',
      activeBackground: 'rgba(255, 50, 150, 0.15)',
      activeBorder: 'rgb(255, 50, 150)',
      selectedBorder: 'rgba(255, 50, 150, 0.9)',
      selectedBackground: 'rgba(255, 50, 150, 0.18)',
      cellActiveBg: 'linear-gradient(90deg, rgba(255, 50, 150, 0.9), rgba(50, 200, 255, 0.9))',
      cellActiveText: '#0f0518',
      noteText: '#fff0f8',
      instrumentText: 'rgba(255, 240, 248, 0.85)',
      volumeText: '#50c8ff',
      effectText: '#ff60b0',
      defaultText: '#f0d0e8'
    }
  },
  {
    id: 'sunset',
    name: 'Sunset Boulevard',
    description: 'Warm sunset gradient colors',
    colors: {
      appBackground: '#140a0c',
      appBackgroundAlt: '#1a0c10',
      headerBackground: '#100808',
      panelBackground: '#1c1012',
      panelBackgroundAlt: '#241418',
      panelBorder: 'rgba(255, 150, 100, 0.1)',
      textPrimary: '#fff8f0',
      textSecondary: '#ffe8d8',
      textMuted: '#c89878',
      buttonBackground: 'rgba(255, 120, 80, 0.15)',
      buttonBackgroundHover: 'rgba(255, 120, 80, 0.25)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(255, 150, 100, 0.2)',
      entryBase: 'rgba(25, 12, 15, 0.85)',
      entryFilled: 'rgba(35, 18, 22, 0.95)',
      entryFilledAlt: 'rgba(30, 15, 18, 0.95)',
      entryRowSub: 'rgba(25, 12, 15, 0.9)',
      entryRowBeat: 'rgba(32, 16, 20, 0.95)',
      entryRowBar: 'rgba(40, 20, 25, 0.98)',
      borderDefault: 'rgba(255, 150, 100, 0.08)',
      borderHover: 'rgba(255, 150, 100, 0.18)',
      borderBeat: 'rgba(255, 150, 100, 0.12)',
      borderBar: 'rgba(255, 100, 80, 0.45)',
      accentPrimary: 'rgb(255, 120, 80)',
      accentSecondary: 'rgb(255, 180, 50)',
      activeBackground: 'rgba(255, 120, 80, 0.15)',
      activeBorder: 'rgb(255, 120, 80)',
      selectedBorder: 'rgba(255, 120, 80, 0.9)',
      selectedBackground: 'rgba(255, 120, 80, 0.18)',
      cellActiveBg: 'linear-gradient(90deg, rgba(255, 100, 80, 0.9), rgba(255, 180, 50, 0.9))',
      cellActiveText: '#1a0c0f',
      noteText: '#fff8f0',
      instrumentText: 'rgba(255, 248, 240, 0.85)',
      volumeText: '#ffb832',
      effectText: '#ff8050',
      defaultText: '#ffe8d8'
    }
  },
  {
    id: 'ocean',
    name: 'Deep Ocean',
    description: 'Calm deep sea blues',
    colors: {
      appBackground: '#060c14',
      appBackgroundAlt: '#080e18',
      headerBackground: '#040810',
      panelBackground: '#0a1420',
      panelBackgroundAlt: '#0e1828',
      panelBorder: 'rgba(100, 180, 255, 0.08)',
      textPrimary: '#f0f8ff',
      textSecondary: '#d0e8ff',
      textMuted: '#7098c8',
      buttonBackground: 'rgba(60, 160, 255, 0.15)',
      buttonBackgroundHover: 'rgba(60, 160, 255, 0.25)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(100, 180, 255, 0.15)',
      entryBase: 'rgba(8, 15, 25, 0.85)',
      entryFilled: 'rgba(12, 22, 38, 0.95)',
      entryFilledAlt: 'rgba(10, 18, 32, 0.95)',
      entryRowSub: 'rgba(8, 15, 25, 0.9)',
      entryRowBeat: 'rgba(11, 20, 35, 0.95)',
      entryRowBar: 'rgba(15, 28, 45, 0.98)',
      borderDefault: 'rgba(100, 180, 255, 0.08)',
      borderHover: 'rgba(100, 180, 255, 0.18)',
      borderBeat: 'rgba(100, 180, 255, 0.12)',
      borderBar: 'rgba(60, 150, 255, 0.45)',
      accentPrimary: 'rgb(60, 160, 255)',
      accentSecondary: 'rgb(100, 220, 255)',
      activeBackground: 'rgba(60, 160, 255, 0.15)',
      activeBorder: 'rgb(60, 160, 255)',
      selectedBorder: 'rgba(60, 160, 255, 0.9)',
      selectedBackground: 'rgba(60, 160, 255, 0.18)',
      cellActiveBg: 'linear-gradient(90deg, rgba(60, 160, 255, 0.9), rgba(100, 220, 255, 0.9))',
      cellActiveText: '#081018',
      noteText: '#f0f8ff',
      instrumentText: 'rgba(240, 248, 255, 0.85)',
      volumeText: '#64dcff',
      effectText: '#3ca0ff',
      defaultText: '#d0e8ff'
    }
  },
  {
    id: 'rose',
    name: 'Rose Gold',
    description: 'Elegant pink and gold',
    colors: {
      appBackground: '#140e10',
      appBackgroundAlt: '#181214',
      headerBackground: '#100c0e',
      panelBackground: '#1c1418',
      panelBackgroundAlt: '#221a1e',
      panelBorder: 'rgba(255, 180, 190, 0.1)',
      textPrimary: '#fff8fa',
      textSecondary: '#ffe8ec',
      textMuted: '#b89098',
      buttonBackground: 'rgba(255, 150, 170, 0.15)',
      buttonBackgroundHover: 'rgba(255, 150, 170, 0.25)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(255, 180, 190, 0.2)',
      entryBase: 'rgba(22, 15, 18, 0.85)',
      entryFilled: 'rgba(32, 22, 26, 0.95)',
      entryFilledAlt: 'rgba(28, 18, 22, 0.95)',
      entryRowSub: 'rgba(22, 15, 18, 0.9)',
      entryRowBeat: 'rgba(30, 20, 24, 0.95)',
      entryRowBar: 'rgba(38, 26, 30, 0.98)',
      borderDefault: 'rgba(255, 180, 190, 0.08)',
      borderHover: 'rgba(255, 180, 190, 0.18)',
      borderBeat: 'rgba(255, 180, 190, 0.12)',
      borderBar: 'rgba(255, 150, 170, 0.45)',
      accentPrimary: 'rgb(255, 150, 170)',
      accentSecondary: 'rgb(255, 200, 150)',
      activeBackground: 'rgba(255, 150, 170, 0.15)',
      activeBorder: 'rgb(255, 150, 170)',
      selectedBorder: 'rgba(255, 150, 170, 0.9)',
      selectedBackground: 'rgba(255, 150, 170, 0.18)',
      cellActiveBg: 'linear-gradient(90deg, rgba(255, 150, 170, 0.9), rgba(255, 200, 150, 0.9))',
      cellActiveText: '#160f12',
      noteText: '#fff8fa',
      instrumentText: 'rgba(255, 248, 250, 0.85)',
      volumeText: '#ffc896',
      effectText: '#ff96aa',
      defaultText: '#ffe8ec'
    }
  },
  {
    id: 'nordic',
    name: 'Nordic Frost',
    description: 'Cool Scandinavian palette',
    colors: {
      appBackground: '#0e1218',
      appBackgroundAlt: '#12161c',
      headerBackground: '#0a0e14',
      panelBackground: '#161a22',
      panelBackgroundAlt: '#1c2028',
      panelBorder: 'rgba(136, 192, 208, 0.1)',
      textPrimary: '#eceff4',
      textSecondary: '#d8dee9',
      textMuted: '#8898a8',
      buttonBackground: 'rgba(136, 192, 208, 0.15)',
      buttonBackgroundHover: 'rgba(136, 192, 208, 0.25)',
      inputBackground: 'rgba(0, 0, 0, 0.25)',
      inputBorder: 'rgba(136, 192, 208, 0.15)',
      entryBase: 'rgba(18, 22, 28, 0.85)',
      entryFilled: 'rgba(26, 32, 40, 0.95)',
      entryFilledAlt: 'rgba(22, 28, 35, 0.95)',
      entryRowSub: 'rgba(18, 22, 28, 0.9)',
      entryRowBeat: 'rgba(24, 30, 38, 0.95)',
      entryRowBar: 'rgba(32, 40, 50, 0.98)',
      borderDefault: 'rgba(136, 192, 208, 0.08)',
      borderHover: 'rgba(136, 192, 208, 0.18)',
      borderBeat: 'rgba(136, 192, 208, 0.12)',
      borderBar: 'rgba(136, 192, 208, 0.45)',
      accentPrimary: 'rgb(136, 192, 208)',
      accentSecondary: 'rgb(163, 190, 140)',
      activeBackground: 'rgba(136, 192, 208, 0.15)',
      activeBorder: 'rgb(136, 192, 208)',
      selectedBorder: 'rgba(136, 192, 208, 0.9)',
      selectedBackground: 'rgba(136, 192, 208, 0.18)',
      cellActiveBg: 'linear-gradient(90deg, rgba(136, 192, 208, 0.9), rgba(163, 190, 140, 0.9))',
      cellActiveText: '#12161c',
      noteText: '#eceff4',
      instrumentText: 'rgba(236, 239, 244, 0.85)',
      volumeText: '#a3be8c',
      effectText: '#88c0d0',
      defaultText: '#d8dee9'
    }
  },
  {
    id: 'aurora',
    name: 'Aurora Borealis',
    description: 'Northern lights magic',
    colors: {
      appBackground: '#080c10',
      appBackgroundAlt: '#0a1014',
      headerBackground: '#06080c',
      panelBackground: '#0c1218',
      panelBackgroundAlt: '#10161e',
      panelBorder: 'rgba(150, 255, 200, 0.08)',
      textPrimary: '#f0fff8',
      textSecondary: '#d8fff0',
      textMuted: '#80b898',
      buttonBackground: 'rgba(100, 255, 180, 0.15)',
      buttonBackgroundHover: 'rgba(100, 255, 180, 0.25)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(150, 255, 200, 0.15)',
      entryBase: 'rgba(10, 15, 20, 0.85)',
      entryFilled: 'rgba(15, 22, 30, 0.95)',
      entryFilledAlt: 'rgba(12, 18, 25, 0.95)',
      entryRowSub: 'rgba(10, 15, 20, 0.9)',
      entryRowBeat: 'rgba(14, 20, 28, 0.95)',
      entryRowBar: 'rgba(18, 28, 38, 0.98)',
      borderDefault: 'rgba(150, 255, 200, 0.08)',
      borderHover: 'rgba(150, 255, 200, 0.18)',
      borderBeat: 'rgba(150, 255, 200, 0.12)',
      borderBar: 'rgba(100, 255, 180, 0.45)',
      accentPrimary: 'rgb(100, 255, 180)',
      accentSecondary: 'rgb(180, 100, 255)',
      activeBackground: 'rgba(100, 255, 180, 0.15)',
      activeBorder: 'rgb(100, 255, 180)',
      selectedBorder: 'rgba(100, 255, 180, 0.9)',
      selectedBackground: 'rgba(100, 255, 180, 0.18)',
      cellActiveBg: 'linear-gradient(90deg, rgba(100, 255, 180, 0.9), rgba(180, 100, 255, 0.9))',
      cellActiveText: '#0a0f14',
      noteText: '#f0fff8',
      instrumentText: 'rgba(240, 255, 248, 0.85)',
      volumeText: '#b464ff',
      effectText: '#64ffb4',
      defaultText: '#d8fff0'
    }
  },
  {
    id: 'cherry',
    name: 'Cherry Blossom',
    description: 'Soft Japanese spring',
    colors: {
      appBackground: '#120c0e',
      appBackgroundAlt: '#160e12',
      headerBackground: '#0e0a0c',
      panelBackground: '#1a1216',
      panelBackgroundAlt: '#20161a',
      panelBorder: 'rgba(255, 183, 197, 0.1)',
      textPrimary: '#fff5f7',
      textSecondary: '#ffe8ee',
      textMuted: '#b08890',
      buttonBackground: 'rgba(255, 183, 197, 0.15)',
      buttonBackgroundHover: 'rgba(255, 183, 197, 0.25)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(255, 183, 197, 0.2)',
      entryBase: 'rgba(20, 15, 18, 0.85)',
      entryFilled: 'rgba(30, 22, 26, 0.95)',
      entryFilledAlt: 'rgba(26, 18, 22, 0.95)',
      entryRowSub: 'rgba(20, 15, 18, 0.9)',
      entryRowBeat: 'rgba(28, 20, 24, 0.95)',
      entryRowBar: 'rgba(36, 26, 30, 0.98)',
      borderDefault: 'rgba(255, 183, 197, 0.1)',
      borderHover: 'rgba(255, 183, 197, 0.2)',
      borderBeat: 'rgba(255, 183, 197, 0.14)',
      borderBar: 'rgba(255, 150, 180, 0.5)',
      accentPrimary: 'rgb(255, 183, 197)',
      accentSecondary: 'rgb(255, 218, 233)',
      activeBackground: 'rgba(255, 183, 197, 0.15)',
      activeBorder: 'rgb(255, 183, 197)',
      selectedBorder: 'rgba(255, 183, 197, 0.9)',
      selectedBackground: 'rgba(255, 183, 197, 0.18)',
      cellActiveBg: 'linear-gradient(90deg, rgba(255, 183, 197, 0.9), rgba(255, 218, 233, 0.9))',
      cellActiveText: '#140f12',
      noteText: '#fff5f7',
      instrumentText: 'rgba(255, 245, 247, 0.85)',
      volumeText: '#ffdae9',
      effectText: '#ffb7c5',
      defaultText: '#ffe8ee'
    }
  },
  {
    id: 'midnight',
    name: 'Midnight Blue',
    description: 'Deep night sky elegance',
    colors: {
      appBackground: '#060810',
      appBackgroundAlt: '#080a14',
      headerBackground: '#04060c',
      panelBackground: '#0a0e18',
      panelBackgroundAlt: '#0e1220',
      panelBorder: 'rgba(120, 140, 200, 0.1)',
      textPrimary: '#f0f2ff',
      textSecondary: '#d8e0f8',
      textMuted: '#808cb8',
      buttonBackground: 'rgba(130, 150, 220, 0.15)',
      buttonBackgroundHover: 'rgba(130, 150, 220, 0.25)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(120, 140, 200, 0.2)',
      entryBase: 'rgba(8, 10, 20, 0.85)',
      entryFilled: 'rgba(14, 18, 32, 0.95)',
      entryFilledAlt: 'rgba(11, 14, 26, 0.95)',
      entryRowSub: 'rgba(8, 10, 20, 0.9)',
      entryRowBeat: 'rgba(12, 16, 30, 0.95)',
      entryRowBar: 'rgba(18, 24, 42, 0.98)',
      borderDefault: 'rgba(120, 140, 200, 0.08)',
      borderHover: 'rgba(120, 140, 200, 0.18)',
      borderBeat: 'rgba(120, 140, 200, 0.12)',
      borderBar: 'rgba(100, 120, 200, 0.45)',
      accentPrimary: 'rgb(130, 150, 220)',
      accentSecondary: 'rgb(180, 190, 240)',
      activeBackground: 'rgba(130, 150, 220, 0.15)',
      activeBorder: 'rgb(130, 150, 220)',
      selectedBorder: 'rgba(130, 150, 220, 0.9)',
      selectedBackground: 'rgba(130, 150, 220, 0.18)',
      cellActiveBg: 'linear-gradient(90deg, rgba(130, 150, 220, 0.9), rgba(180, 190, 240, 0.9))',
      cellActiveText: '#080a14',
      noteText: '#f0f2ff',
      instrumentText: 'rgba(240, 242, 255, 0.85)',
      volumeText: '#b4bef0',
      effectText: '#8296dc',
      defaultText: '#d8e0f8'
    }
  },
  {
    id: 'ember',
    name: 'Glowing Ember',
    description: 'Fiery red and orange',
    colors: {
      appBackground: '#100806',
      appBackgroundAlt: '#140a08',
      headerBackground: '#0c0604',
      panelBackground: '#180c0a',
      panelBackgroundAlt: '#1e100c',
      panelBorder: 'rgba(255, 100, 50, 0.1)',
      textPrimary: '#fff5f0',
      textSecondary: '#ffe0d0',
      textMuted: '#b87860',
      buttonBackground: 'rgba(255, 90, 50, 0.15)',
      buttonBackgroundHover: 'rgba(255, 90, 50, 0.25)',
      inputBackground: 'rgba(0, 0, 0, 0.3)',
      inputBorder: 'rgba(255, 100, 50, 0.2)',
      entryBase: 'rgba(20, 10, 8, 0.85)',
      entryFilled: 'rgba(32, 16, 12, 0.95)',
      entryFilledAlt: 'rgba(26, 13, 10, 0.95)',
      entryRowSub: 'rgba(20, 10, 8, 0.9)',
      entryRowBeat: 'rgba(28, 14, 11, 0.95)',
      entryRowBar: 'rgba(38, 20, 15, 0.98)',
      borderDefault: 'rgba(255, 100, 50, 0.08)',
      borderHover: 'rgba(255, 100, 50, 0.18)',
      borderBeat: 'rgba(255, 100, 50, 0.12)',
      borderBar: 'rgba(255, 80, 30, 0.5)',
      accentPrimary: 'rgb(255, 90, 50)',
      accentSecondary: 'rgb(255, 160, 50)',
      activeBackground: 'rgba(255, 90, 50, 0.15)',
      activeBorder: 'rgb(255, 90, 50)',
      selectedBorder: 'rgba(255, 90, 50, 0.9)',
      selectedBackground: 'rgba(255, 90, 50, 0.18)',
      cellActiveBg: 'linear-gradient(90deg, rgba(255, 90, 50, 0.9), rgba(255, 160, 50, 0.9))',
      cellActiveText: '#140a08',
      noteText: '#fff5f0',
      instrumentText: 'rgba(255, 245, 240, 0.85)',
      volumeText: '#ffa032',
      effectText: '#ff5a32',
      defaultText: '#ffe0d0'
    }
  }
];

// Track loaded Google Fonts to avoid duplicate link elements
const loadedFonts = new Set<string>();

function loadGoogleFont(fontId: string, googleFont: string) {
  if (loadedFonts.has(fontId)) return;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${googleFont}&display=swap`;
  document.head.appendChild(link);
  loadedFonts.add(fontId);
}

function applyFonts(uiFontId: string, trackerFontId: string) {
  const root = document.documentElement;

  // Find font definitions
  const uiFont = uiFonts.find((f) => f.id === uiFontId) ?? uiFonts[0]!;
  const trackerFont = monospaceFonts.find((f) => f.id === trackerFontId) ?? monospaceFonts[0]!;

  // Load fonts from Google Fonts
  loadGoogleFont(uiFont.id, uiFont.googleFont);
  loadGoogleFont(trackerFont.id, trackerFont.googleFont);

  // Apply CSS variables
  root.style.setProperty('--font-ui', `'${uiFont.id}', sans-serif`);
  root.style.setProperty('--font-tracker', `'${trackerFont.id}', monospace`);
}

export const useThemeStore = defineStore('theme', () => {
  const userSettings = useUserSettingsStore();
  const basePreset = themePresets[0]!;
  const defaultCustomTheme: TrackerTheme = {
    ...basePreset,
    id: 'custom',
    name: 'Custom',
    description: 'Your custom colors',
    colors: { ...basePreset.colors }
  };

  function loadCustomTheme(): TrackerTheme {
    try {
      const stored = localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as TrackerTheme;
        return { ...defaultCustomTheme, ...parsed, colors: { ...defaultCustomTheme.colors, ...parsed.colors } };
      }
    } catch (error) {
      console.warn('Failed to load custom theme:', error);
    }
    return { ...defaultCustomTheme };
  }

  const customTheme = ref<TrackerTheme>(loadCustomTheme());

  // Get current theme ID from user settings
  const currentThemeId = computed({
    get: () => userSettings.settings.theme,
    set: (value: string) => {
      userSettings.updateSetting('theme', value);
    }
  });

  // Get current fonts from user settings
  const currentUiFont = computed({
    get: () => userSettings.settings.uiFont,
    set: (value: string) => {
      userSettings.updateSetting('uiFont', value);
    }
  });

  const currentTrackerFont = computed({
    get: () => userSettings.settings.trackerFont,
    set: (value: string) => {
      userSettings.updateSetting('trackerFont', value);
    }
  });

  const allThemes = computed<TrackerTheme[]>(() => [customTheme.value, ...themePresets]);

  function getThemeById(id: string): TrackerTheme {
    return allThemes.value.find((t) => t.id === id) ?? allThemes.value[0]!;
  }

  const currentTheme = ref<TrackerTheme>(getThemeById(currentThemeId.value));

  // Watch for theme changes and update CSS variables
  watch(
    currentThemeId,
    (newThemeId) => {
      const theme = getThemeById(newThemeId);
      currentTheme.value = theme;
      applyTheme(theme);
    },
    { immediate: true }
  );

  // Watch for font changes and apply them
  watch(
    [currentUiFont, currentTrackerFont],
    ([uiFont, trackerFont]) => {
      applyFonts(uiFont, trackerFont);
    },
    { immediate: true }
  );

  function applyTheme(theme: TrackerTheme) {
    const root = document.documentElement;
    const { colors } = theme;

    // App-wide colors
    root.style.setProperty('--app-background', colors.appBackground);
    root.style.setProperty('--app-background-alt', colors.appBackgroundAlt);
    root.style.setProperty('--header-background', colors.headerBackground);
    root.style.setProperty('--panel-background', colors.panelBackground);
    root.style.setProperty('--panel-background-alt', colors.panelBackgroundAlt);
    root.style.setProperty('--panel-border', colors.panelBorder);

    // Text colors
    root.style.setProperty('--text-primary', colors.textPrimary);
    root.style.setProperty('--text-secondary', colors.textSecondary);
    root.style.setProperty('--text-muted', colors.textMuted);

    // Interactive elements
    root.style.setProperty('--button-background', colors.buttonBackground);
    root.style.setProperty('--button-background-hover', colors.buttonBackgroundHover);
    root.style.setProperty('--input-background', colors.inputBackground);
    root.style.setProperty('--input-border', colors.inputBorder);

    // Tracker entry backgrounds
    root.style.setProperty('--tracker-entry-base', colors.entryBase);
    root.style.setProperty('--tracker-entry-filled', colors.entryFilled);
    root.style.setProperty('--tracker-entry-filled-alt', colors.entryFilledAlt);
    root.style.setProperty('--tracker-entry-row-sub', colors.entryRowSub);
    root.style.setProperty('--tracker-entry-row-beat', colors.entryRowBeat);
    root.style.setProperty('--tracker-entry-row-bar', colors.entryRowBar);

    // Entry borders
    root.style.setProperty('--tracker-border-default', colors.borderDefault);
    root.style.setProperty('--tracker-border-hover', colors.borderHover);
    root.style.setProperty('--tracker-border-beat', colors.borderBeat);
    root.style.setProperty('--tracker-border-bar', colors.borderBar);

    // Accent colors
    root.style.setProperty('--tracker-accent-primary', colors.accentPrimary);
    root.style.setProperty('--tracker-accent-secondary', colors.accentSecondary);
    root.style.setProperty('--tracker-active-bg', colors.activeBackground);
    root.style.setProperty('--tracker-active-border', colors.activeBorder);
    root.style.setProperty('--tracker-selected-border', colors.selectedBorder);
    root.style.setProperty('--tracker-selected-bg', colors.selectedBackground);
    root.style.setProperty('--tracker-cell-active-bg', colors.cellActiveBg);
    root.style.setProperty('--tracker-cell-active-text', colors.cellActiveText);

    // Cell text colors
    root.style.setProperty('--tracker-note-text', colors.noteText);
    root.style.setProperty('--tracker-instrument-text', colors.instrumentText);
    root.style.setProperty('--tracker-volume-text', colors.volumeText);
    root.style.setProperty('--tracker-effect-text', colors.effectText);
    root.style.setProperty('--tracker-default-text', colors.defaultText);
  }

  function setTheme(themeId: string) {
    currentThemeId.value = themeId;
  }

  function setCustomTheme(theme: TrackerTheme) {
    customTheme.value = {
      ...theme,
      id: 'custom',
      name: theme.name || 'Custom',
      description: theme.description || 'Your custom colors'
    };
    localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(customTheme.value));
    if (currentThemeId.value === 'custom') {
      currentTheme.value = customTheme.value;
      applyTheme(customTheme.value);
    }
  }

  function copyThemeToCustom(themeId: string) {
    const base = getThemeById(themeId);
    setCustomTheme({
      ...base,
      id: 'custom',
      name: 'Custom',
      description: 'Your custom colors'
    });
    setTheme('custom');
  }

  watch(
    customTheme,
    (theme) => {
      try {
        localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(theme));
      } catch (error) {
        console.warn('Failed to persist custom theme:', error);
      }
    },
    { deep: true }
  );

  function setUiFont(fontId: string) {
    currentUiFont.value = fontId;
  }

  function setTrackerFont(fontId: string) {
    currentTrackerFont.value = fontId;
  }

  return {
    currentThemeId,
    currentTheme,
    currentUiFont,
    currentTrackerFont,
    themePresets,
    customTheme,
    allThemes,
    uiFonts,
    monospaceFonts,
    setTheme,
    setCustomTheme,
    copyThemeToCustom,
    getThemeById,
    setUiFont,
    setTrackerFont
  };
});
