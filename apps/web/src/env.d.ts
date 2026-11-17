interface AgeShell {
  platform: string;
  versions: { electron: string; chrome: string; node: string };
}

interface Window {
  age?: AgeShell;
}
