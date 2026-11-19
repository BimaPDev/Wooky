import { contextBridge, ipcRenderer } from "electron";

// Sandboxed preload: the page can read this description and ask for one folder.
contextBridge.exposeInMainWorld("wooky", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node,
  },
  pickFolder(): Promise<string | null> {
    return ipcRenderer.invoke("wooky:pick-folder").then((picked: unknown) => {
      return typeof picked === "string" && picked.length > 0 ? picked : null;
    });
  },
});
