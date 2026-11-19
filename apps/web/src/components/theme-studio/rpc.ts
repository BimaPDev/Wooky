import { activateTheme, loadDeviceSettings } from "../../state/appearance.ts";
import { backend } from "../../state/backend.ts";

/** Activate via themes.activate, then apply the listed theme so colour mode matches. */
export async function activateListedTheme(id: string, appearance: "dark" | "light" = "dark") {
  await backend().call("themes.activate", { id });
  return activateTheme(id, appearance);
}

export async function importThemeText(text: string, filename?: string) {
  const result = await backend().call("themes.import", { text, filename, activate: true });
  await loadDeviceSettings();
  return result;
}
