import { contextBridge } from "electron";

// Sandboxed preload: the only thing the page gets from the shell is this read-only description.
contextBridge.exposeInMainWorld("age", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node,
  },
});
