import { useState } from "react";
import { pairRoute } from "../format.ts";
import { browserDeviceName } from "./device.ts";
import { pairWithHost } from "./pair.ts";

/** `/#/pair?code=…`: pair this browser with the host that served the page, then open the app. */
export function PairPage() {
  const initial = pairRoute(location.hash)?.code ?? "";
  const [code, setCode] = useState(initial);
  const [name, setName] = useState(() => browserDeviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const outcome = await pairWithHost(code, name);
    setBusy(false);
    if (outcome.ok) setHost(outcome.hostName);
    else setError(outcome.message);
  };

  const open = () => {
    location.hash = "";
    location.reload();
  };

  return (
    <main className="pair-page">
      <form
        className="pair-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!host) void submit();
        }}
      >
        <h1 className="pair-title">Pair this browser</h1>
        {host ? (
          <>
            <p className="pair-body" role="status">
              Paired with {host}.
            </p>
            <button type="button" className="button primary" autoFocus onClick={open}>
              Open Wooky
            </button>
          </>
        ) : (
          <>
            <p className="pair-body">
              Enter the code shown on the host under Settings, then Anywhere. A code works once.
            </p>
            <label className="field">
              <span>Pairing code</span>
              <input
                className="mono"
                value={code}
                placeholder="ABCD EFGH"
                autoComplete="off"
                spellCheck={false}
                autoFocus={initial === ""}
                aria-label="Pairing code"
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            <label className="field">
              <span>This device</span>
              <input
                value={name}
                autoComplete="off"
                aria-label="Device name"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}
            <button type="submit" className="button primary" disabled={busy || code.trim() === ""}>
              {busy ? "Pairing" : "Pair"}
            </button>
          </>
        )}
      </form>
    </main>
  );
}
