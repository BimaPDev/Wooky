import { encodeQr } from "./qr.ts";

export function QrCode({ text }: { text: string }) {
  const qr = encodeQr(text);
  const path: string[] = [];
  qr.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path.push(`M${x} ${y}h1v1h-1z`);
    });
  });
  const quiet = 4;
  const view = qr.size + quiet * 2;
  return (
    <svg
      className="anywhere-qr"
      role="img"
      aria-label="Pairing QR code"
      viewBox={`${-quiet} ${-quiet} ${view} ${view}`}
    >
      <rect x={-quiet} y={-quiet} width={view} height={view} fill="var(--bg-0)" />
      <path d={path.join("")} fill="var(--text)" />
    </svg>
  );
}
