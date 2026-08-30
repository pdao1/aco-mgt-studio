export const THEME_IDS = ['classic-light', 'slate-light', 'mint-light', 'sand-light',
  'midnight-dark', 'graphite-dark', 'nord-dark', 'dracula-dark'] as const;
export type WorkspaceTheme = typeof THEME_IDS[number];

export const WORKSPACE_THEMES: Array<{ id: WorkspaceTheme; name: string; mode: 'light' | 'dark'; background: string; surface: string; accent: string }> = [
  { id: 'classic-light', name: 'Classic', mode: 'light', background: '#f7f9fc', surface: '#ffffff', accent: '#1463f3' },
  { id: 'slate-light', name: 'Slate', mode: 'light', background: '#eef2f6', surface: '#f8fafc', accent: '#475d82' },
  { id: 'mint-light', name: 'Mint', mode: 'light', background: '#eef6f1', surface: '#fbfefc', accent: '#147d59' },
  { id: 'sand-light', name: 'Sand', mode: 'light', background: '#f5f0e7', surface: '#fffdf8', accent: '#97612e' },
  { id: 'midnight-dark', name: 'Midnight', mode: 'dark', background: '#0b1120', surface: '#111c30', accent: '#85b7ff' },
  { id: 'graphite-dark', name: 'Graphite', mode: 'dark', background: '#141416', surface: '#202023', accent: '#b4b4fc' },
  { id: 'nord-dark', name: 'Nord', mode: 'dark', background: '#242c39', surface: '#2e3949', accent: '#88c0d0' },
  { id: 'dracula-dark', name: 'Dracula', mode: 'dark', background: '#20212c', surface: '#282a36', accent: '#bd93f9' },
];
