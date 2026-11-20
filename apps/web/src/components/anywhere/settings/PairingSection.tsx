import { useEffect, useState } from "react";
import { backend } from "../../../state/backend.ts";
import { useStore } from "../../../state/store.ts";
import { groupPairingCode, pairingQrText } from "../format.ts";
import { SettingsBlock } from "./controls.tsx";
import { QrCode } from "./QrCode.tsx";

export function PairingSection() {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; url: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const show = async () => {
    setBusy(true);
    try {
      setPairing(await backend().call("remote.pairingCode.create", {}));
    } catch (error) {
      useStore.setState({
        notice: error instanceof Error ? error.message : "Could not create a pairing code.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsBlock
      title="Pair a device"
      action={
        pairing ? (
          <button type="button" className="ghost-button" onClick={() => setPairing(null)}>
            Hide code
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void show()}
          >
            Show pairing code
          </button>
        )
      }
    >
      {pairing ? (
        <PairingCodeView code={pairing.code} expiresAt={pairing.expiresAt} url={pairing.url} />
      ) : (
        <p className="settings-help">
          A code works once, for 10 minutes. On the other machine, enter it under Add machine, or
          open the QR. You can also run <code>wooky pair</code>.
        </p>
      )}
    </SettingsBlock>
  );
}

export function PairingCodeView({
  code,
  expiresAt,
  url,
}: {
  code: string;
  expiresAt: string;
  url: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const qrText = pairingQrText(url, code);
  const remain = Math.max(0, new Date(expiresAt).getTime() - now);
  const seconds = Math.ceil(remain / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  // sync: one-second clock for the pairing code expiry, only while this view is mounted
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(() => {
        const next = Date.now();
        if (next >= new Date(expiresAt).getTime()) window.clearInterval(id);
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(qrText);
      setCopied(true);
    } catch {
      useStore.setState({ notice: "Could not copy the pairing URL." });
    }
  };

  return (
    <div className="anywhere-pair">
      <p className="anywhere-code" aria-label={`Pairing code ${groupPairingCode(code)}`}>
        {groupPairingCode(code)}
      </p>
      <p className="setting-desc">{remain === 0 ? "Expired" : `Expires in ${clock}`}</p>
      <QrCode text={qrText} />
      <div className="anywhere-url">
        <code className="mono">{qrText}</code>
        <button type="button" className="button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="setting-desc">
        Or, on this machine, run <code>wooky pair</code>.
      </p>
    </div>
  );
}
