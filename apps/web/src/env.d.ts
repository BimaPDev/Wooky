interface WookyShell {
  platform: string;
  versions: { electron: string; chrome: string; node: string };
  /** Desktop shell only. Resolves to the chosen folder, or null when cancelled. */
  pickFolder?: () => Promise<string | null>;
}

interface Window {
  wooky?: WookyShell;
}
