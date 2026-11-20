import {
  PairingCodeText,
  RemoteConnection,
  type RemoteConnection as Connection,
} from "@wooky/contracts";
import { useState } from "react";
import { loadDeviceSettings } from "../../../state/appearance.ts";
import { backend } from "../../../state/backend.ts";
import { useStore } from "../../../state/store.ts";
import { directPublicHttpWarning, splitPairingLink } from "../format.ts";

type Kind = Connection["kind"];

const HELP: Record<Kind, string> = {
  tailscale: "MagicDNS name on your tailnet.",
  direct: "An http(s) address on your LAN, or any routable host.",
  url: "A reverse proxy or tunnel. Public hosts must be https.",
  ssh: "Forwards a local port to the server over SSH. user@host, no leading dash.",
};

export function AddMachineForm({
  onClose,
  tailscaleHint,
}: {
  onClose: () => void;
  tailscaleHint?: string | null;
}) {
  const [kind, setKind] = useState<Kind>("tailscale");
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [hostName, setHostName] = useState("");
  const [port, setPort] = useState("4317");
  const [https, setHttps] = useState(true);
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState("");
  const [remotePort, setRemotePort] = useState("4317");
  const [localPort, setLocalPort] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const connection = draftConnection({
    kind,
    hostName,
    port,
    https,
    url,
    target,
    remotePort,
    localPort,
    identityFile,
  });
  const parsed = RemoteConnection.safeParse(connection);
  const codeParsed = PairingCodeText.safeParse(code.replace(/\s+/g, ""));
  const warning = kind === "direct" && url.trim() ? directPublicHttpWarning(url) : null;
  const issues = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  const showIssues = submitted || hasDraft(kind, { hostName, url, target, identityFile });

  const submit = async () => {
    setSubmitted(true);
    setFormError(null);
    if (!parsed.success || !codeParsed.success) return;
    setBusy(true);
    try {
      const result = await backend().call("remote.join", {
        connection: parsed.data,
        code: codeParsed.data,
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      await loadDeviceSettings();
      const current = useStore.getState().deviceSettings;
      if (current && !current.environments.some((entry) => entry.id === result.environment.id)) {
        useStore.setState({
          deviceSettings: {
            ...current,
            environments: [...current.environments, result.environment],
          },
        });
      }
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not add that machine.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="modal-title">Add machine</h2>
      <p className="modal-body">
        Enter the pairing code shown on the other machine. The connection is how this client reaches
        it.
      </p>
      <label className="field">
        <span>Name</span>
        <input
          value={label}
          placeholder="Home server"
          autoComplete="off"
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Connection</span>
        <select
          aria-label="Connection"
          value={kind}
          onChange={(event) => setKind(event.target.value as Kind)}
        >
          <option value="tailscale">Tailscale</option>
          <option value="direct">Direct URL</option>
          <option value="url">Custom URL</option>
          <option value="ssh">SSH</option>
        </select>
      </label>
      <p className="setting-desc anywhere-kind-help">{HELP[kind]}</p>
      {kind === "tailscale" ? (
        <>
          <label className="field">
            <span>Hostname</span>
            <input
              className="mono"
              value={hostName}
              placeholder={tailscaleHint || "home.tailnet.ts.net"}
              spellCheck={false}
              autoComplete="off"
              aria-label="Tailscale hostname"
              onChange={(event) => setHostName(event.target.value)}
            />
          </label>
          {/* TODO(A1): TailscaleStatus has no peer list, so the hostname is typed. */}
          <p className="setting-desc">
            Tailscale status does not list other machines yet. Type the MagicDNS name.
          </p>
          <PortField label="Port" value={port} onChange={setPort} />
          <label className="option">
            <input
              type="checkbox"
              checked={https}
              onChange={(event) => setHttps(event.target.checked)}
            />
            <span>Use HTTPS</span>
          </label>
        </>
      ) : null}
      {kind === "direct" || kind === "url" ? (
        <label className="field">
          <span>URL</span>
          <input
            className="mono"
            value={url}
            placeholder={
              kind === "direct" ? "http://192.168.1.20:4317" : "https://wooky.example.com"
            }
            spellCheck={false}
            autoComplete="off"
            aria-label={kind === "direct" ? "Direct URL" : "Custom URL"}
            onChange={(event) => {
              // A pasted pairing link carries the one-time code: keep it out of the stored URL.
              const link = splitPairingLink(event.target.value);
              setUrl(link.url);
              if (link.code) setCode(link.code);
            }}
          />
        </label>
      ) : null}
      {warning ? (
        <p className="anywhere-warn" role="status">
          {warning}
        </p>
      ) : null}
      {kind === "ssh" ? (
        <>
          <label className="field">
            <span>Target</span>
            <input
              className="mono"
              value={target}
              placeholder="user@host"
              spellCheck={false}
              autoComplete="off"
              aria-label="SSH target"
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
          <PortField label="Remote port" value={remotePort} onChange={setRemotePort} />
          <PortField label="Local port" value={localPort} onChange={setLocalPort} optional />
          <label className="field">
            <span>Identity file</span>
            <input
              className="mono"
              value={identityFile}
              placeholder="~/.ssh/id_ed25519"
              spellCheck={false}
              autoComplete="off"
              aria-label="Identity file"
              onChange={(event) => setIdentityFile(event.target.value)}
            />
          </label>
        </>
      ) : null}
      {showIssues
        ? issues.map((message) => (
            <p key={message} className="field-error" role="alert">
              {message}
            </p>
          ))
        : null}
      <label className="field">
        <span>Pairing code</span>
        <input
          className="mono"
          value={code}
          placeholder="ABCD EFGH"
          spellCheck={false}
          autoComplete="off"
          aria-label="Pairing code"
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      {submitted && !codeParsed.success ? (
        <p className="field-error" role="alert">
          Expected an 8-character pairing code
        </p>
      ) : null}
      {formError ? (
        <p className="field-error" role="alert">
          {formError}
        </p>
      ) : null}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          Add machine
        </button>
      </div>
    </form>
  );
}

function PortField({
  label,
  value,
  onChange,
  optional = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {optional ? <span className="muted"> · optional</span> : null}
      </span>
      <input
        inputMode="numeric"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function hasDraft(
  kind: Kind,
  fields: { hostName: string; url: string; target: string; identityFile: string },
) {
  if (kind === "tailscale") return fields.hostName.trim().length > 0;
  if (kind === "ssh")
    return fields.target.trim().length > 0 || fields.identityFile.trim().length > 0;
  return fields.url.trim().length > 0;
}

function draftConnection(input: {
  kind: Kind;
  hostName: string;
  port: string;
  https: boolean;
  url: string;
  target: string;
  remotePort: string;
  localPort: string;
  identityFile: string;
}): unknown {
  if (input.kind === "tailscale") {
    return {
      kind: "tailscale",
      hostName: input.hostName.trim(),
      port: Number(input.port),
      https: input.https,
    };
  }
  if (input.kind === "direct" || input.kind === "url") {
    return { kind: input.kind, url: input.url.trim() };
  }
  const local = input.localPort.trim();
  const identity = input.identityFile.trim();
  return {
    kind: "ssh",
    target: input.target.trim(),
    remotePort: Number(input.remotePort),
    ...(local ? { localPort: Number(local) } : {}),
    ...(identity ? { identityFile: identity } : {}),
  };
}
