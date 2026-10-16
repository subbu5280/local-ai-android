/**
 * Colors for light and dark mode, shared by every screen. "Night indigo" with a marigold accent: deep blue surfaces
 * like an evening sky, and the warm marigold of a festival lamp for what you can act on.
 * - accent: links, borders and filled buttons; onAccent is the text on a filled accent button.
 * - mine: your own chat bubbles (white text). ok: the "model ready" dot.
 * Contrast: accent text on bg and onAccent on accent are at least 4.5:1 in both modes (WCAG AA).
 */
export const lightColors = { bg: '#f5f5fb', text: '#1a1b33', muted: '#5c5f84', border: '#dcdded', bubble: '#ffffff',
  accent: '#9a5600', onAccent: '#ffffff', mine: '#3d43a8', ok: '#1f8a4c', errorBg: '#fde8ea', stop: '#b3261e' };
export const darkColors: Colors = { bg: '#12142a', text: '#ecebf5', muted: '#9c9ec2', border: '#2c305c', bubble: '#1e2145',
  accent: '#f4b23e', onAccent: '#1a1530', mine: '#3d43a8', ok: '#4cd38a', errorBg: '#4a1f2b', stop: '#e5484d' };
export type Colors = typeof lightColors;
