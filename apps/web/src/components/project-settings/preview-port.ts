const LOCAL_URL = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d+)/i;

/** First localhost / 127.0.0.1 port printed in terminal output, if any. */
export function detectPreviewPort(text: string): number | null {
  const match = LOCAL_URL.exec(text);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function resolvePreviewUrl(template: string, port: number | null): string | null {
  if (!template.includes("${PORT}")) return template;
  if (port === null) return null;
  return template.split("${PORT}").join(String(port));
}

export function previewTemplate(
  scriptPreview: string | undefined,
  defaultPreview: string | undefined,
): string | undefined {
  return scriptPreview || defaultPreview;
}
