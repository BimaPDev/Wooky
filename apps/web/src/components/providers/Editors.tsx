import { useState } from "react";
import { IconClose, IconPlus } from "../Icons.tsx";
import {
  envKeyProblem,
  envToRows,
  LIMITS,
  listToRows,
  nextRowId,
  removeRow,
  rowsToEnv,
  rowsToList,
  type EnvRow,
  type ListRow,
} from "./helpers.ts";

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? "toggle on" : "toggle"}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-thumb" />
    </button>
  );
}

/**
 * One value per row. Blank rows stay on screen while you type and never reach `onChange`.
 * Starts from `initial` once; mount it with a `key` to reset it.
 */
export function ListEditor({
  label,
  itemLabel,
  initial,
  max,
  maxLength,
  placeholder,
  mono = true,
  onChange,
}: {
  label: string;
  itemLabel: string;
  initial: readonly string[];
  max: number;
  maxLength: number;
  placeholder: string;
  mono?: boolean;
  onChange: (list: string[]) => void;
}) {
  const [rows, setRows] = useState<ListRow[]>(() => listToRows(initial));
  const [focusId, setFocusId] = useState<number | null>(null);

  const commit = (next: ListRow[]) => {
    setRows(next);
    onChange(rowsToList(next));
  };

  return (
    <div className="editor-list" role="group" aria-label={label}>
      {rows.map((row, index) => (
        <div className="editor-row" key={row.id}>
          <input
            className={mono ? "provider-input mono" : "provider-input"}
            value={row.value}
            maxLength={maxLength}
            placeholder={placeholder}
            aria-label={`${itemLabel} ${index + 1}`}
            autoFocus={row.id === focusId}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) =>
              commit(rows.map((r) => (r.id === row.id ? { ...r, value: event.target.value } : r)))
            }
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${itemLabel.toLowerCase()} ${index + 1}`}
            onClick={() => commit(removeRow(rows, row.id))}
          >
            <IconClose />
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="ghost-button"
          disabled={rows.length >= max}
          onClick={() => {
            const id = nextRowId(rows);
            setFocusId(id);
            setRows([...rows, { id, value: "" }]);
          }}
        >
          <IconPlus />
          Add {itemLabel.toLowerCase()}
        </button>
      </div>
    </div>
  );
}

/** Environment variables as name and value rows. Values are hidden until you choose to show them. */
export function EnvEditor({
  initial,
  onChange,
}: {
  initial: Readonly<Record<string, string>>;
  onChange: (env: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState<EnvRow[]>(() => envToRows(initial));
  const [shown, setShown] = useState(false);
  const [focusId, setFocusId] = useState<number | null>(null);

  const commit = (next: EnvRow[]) => {
    setRows(next);
    onChange(rowsToEnv(next));
  };

  return (
    <div className="editor-list" role="group" aria-label="Environment variables">
      {rows.map((row, index) => {
        const problem = envKeyProblem(row.key, rows);
        return (
          <div className="editor-env-row" key={row.id}>
            <input
              className="provider-input mono"
              value={row.key}
              maxLength={256}
              placeholder="NAME"
              aria-label={`Variable name ${index + 1}`}
              aria-invalid={problem !== null}
              autoFocus={row.id === focusId}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) =>
                commit(rows.map((r) => (r.id === row.id ? { ...r, key: event.target.value } : r)))
              }
            />
            <input
              className="provider-input mono"
              type={shown ? "text" : "password"}
              value={row.value}
              maxLength={LIMITS.envValue}
              placeholder="value"
              aria-label={`Variable value ${index + 1}`}
              spellCheck={false}
              autoComplete="off"
              data-1p-ignore=""
              onChange={(event) =>
                commit(rows.map((r) => (r.id === row.id ? { ...r, value: event.target.value } : r)))
              }
            />
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove variable ${index + 1}`}
              onClick={() => commit(removeRow(rows, row.id))}
            >
              <IconClose />
            </button>
            {problem ? (
              <p className="editor-problem" role="alert">
                {problem}
              </p>
            ) : null}
          </div>
        );
      })}
      <div className="editor-actions">
        <button
          type="button"
          className="ghost-button"
          disabled={rows.length >= LIMITS.env}
          onClick={() => {
            const id = nextRowId(rows);
            setFocusId(id);
            setRows([...rows, { id, key: "", value: "" }]);
          }}
        >
          <IconPlus />
          Add variable
        </button>
        {rows.length > 0 ? (
          <button
            type="button"
            className="ghost-button"
            aria-pressed={shown}
            onClick={() => setShown(!shown)}
          >
            {shown ? "Hide values" : "Show values"}
          </button>
        ) : null}
      </div>
      <p className="setting-desc">Stored only in this computer&apos;s settings file.</p>
    </div>
  );
}
