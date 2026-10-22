import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "./api";
import { Group } from "./common";
import { bytes } from "./helpers";
import { openCopy, run, toast } from "./store";
import type { Storage, StoragePart } from "./types";
export function LaciStorage() {
  const [storage, setStorage] = useState<Storage | null>(null);
  const [asking, setAsking] = useState<StoragePart["id"] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api<Storage>("storage").then(
        (value) => {
          setStorage(value);
          setError("");
        },
        (e) => setError(errorText(e)),
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const free = (part: StoragePart) =>
    void run(async () => {
      const result = await api<{ freed?: number }>("storage/free", {
        part: part.id,
      });
      setAsking(null);
      await load();
      toast(`Freed ${bytes(result.freed ?? part.free)}`);
    }, `Freeing ${part.label.toLowerCase()}…`);
  return (
    <Group
      title="Laci's storage"
      icon="drive"
      hint={storage ? `${bytes(storage.total)} in ${storage.dir}` : undefined}
    >
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      {storage?.parts.map((part) => (
        <div className="item" key={part.id} style={{ flexWrap: "wrap" }}>
          <span className="name" style={{ maxWidth: "none", flex: 1 }}>
            {part.label}
            <span
              className="faint"
              style={{ display: "block", fontWeight: 400 }}
            >
              {part.about}
              {part.dir ? (
                <span className="mono" style={{ display: "block" }}>
                  In {part.dir}
                </span>
              ) : null}
              {part.error ? (
                <span className="err" role="alert" style={{ display: "block" }}>
                  {part.error}
                </span>
              ) : null}
            </span>
          </span>
          <span className="meta">{bytes(part.bytes)}</span>
          {part.id === "history" && part.dir && !part.error && part.bytes > 0 ? (
            <button className="btn sm" onClick={() => part.dir && openCopy(part.dir)}>
              Open backup folder
            </button>
          ) : null}
          {part.free > 0 && asking !== part.id ? (
            <button className="btn sm" onClick={() => setAsking(part.id)}>
              Free {bytes(part.free)}…
            </button>
          ) : null}
          {asking === part.id ? (
            <div
              className="row-acts"
              style={{ flexBasis: "100%", paddingLeft: 22 }}
            >
              <span className="muted" style={{ fontSize: 12 }}>
                Free {bytes(part.free)} for good? {part.about}
              </span>
              <span className="grow" />
              <button className="btn sm" onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button className="btn sm primary" onClick={() => free(part)}>
                Free {bytes(part.free)}
              </button>
            </div>
          ) : null}
        </div>
      ))}
      {storage ? (
        <div className="item">
          <span className="name" style={{ maxWidth: "none", flex: 1 }}>
            Total
          </span>
          <span className="meta">{bytes(storage.total)}</span>
        </div>
      ) : !error ? (
        <p className="faint hnote" role="status">
          Loading…
        </p>
      ) : null}
    </Group>
  );
}
