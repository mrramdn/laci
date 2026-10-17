// The sheet behind every fix button: before a version is saved or uploaded, Laci looks for files
// that look like passwords or keys (by name only) and offers to keep them out; then the user picks
// their AI (recommended) or the command in the terminal.
import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { useHealth } from "../hooks";
import { changed, run, toast, useApp } from "../store";
import { openTerminal } from "../terminal-api";
import type { Change, Node } from "../types";
import { blocks, fix, project as said } from "../words";
import { aiName, askFix } from "./act";
import { AI_FIXES, SECRET_CHECKED, TERMINAL_FIXES } from "./model";
import { useSimple } from "./state";
import { Button, Callout, Disclosure, Sheet } from "./ui";

/** The `secrets/check` reply: paths in the project, by name only. */
interface SecretCheck {
  files: { path: string; tracked: boolean }[];
  more: number;
}
type Check =
  | { state: "checking" }
  | { state: "done"; found: SecretCheck }
  | { state: "failed"; error: string };

const SHOWN = 6;

/** The fix sheet, when one is open. */
export function FixSheet() {
  const fixing = useSimple((s) => s.fixing);
  const node = useApp((s) =>
    fixing ? s.snapshot?.nodes[fixing.id] : undefined,
  );
  if (!fixing || !node) return null;
  return <FixFor key={`${fixing.id} ${fixing.code}`} node={node} code={fixing.code} />;
}

function FixFor({ node, code }: { node: Node; code: string }) {
  const snapshot = useApp((s) => s.snapshot!);
  const historyPending = useApp((s) => s.historyPending);
  const ai = aiName(snapshot);
  const checks = SECRET_CHECKED.has(code);
  const [check, setCheck] = useState<Check>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!checks) return;
    let live = true;
    setCheck({ state: "checking" });
    api<SecretCheck>("secrets/check", { id: node.id }).then(
      (found) => {
        if (live) setCheck({ state: "done", found });
      },
      (error) => {
        if (live) setCheck({ state: "failed", error: errorText(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [checks, node.id, attempt]);
  const close = () => useSimple.setState({ fixing: null });
  const files = check.state === "done" ? check.found.files : [];
  const loose = files.filter((file) => !file.tracked);
  const tracked = files.filter((file) => file.tracked);
  const more = check.state === "done" ? check.found.more : 0;
  // What stops the terminal: secret files to keep out first, ones already saved, or no check.
  const blocked = !checks
    ? ""
    : check.state === "checking"
      ? fix.checking
      : check.state === "failed"
        ? fix.blockedFailed
        : tracked.length
          ? fix.blockedTracked
          : loose.length
            ? fix.blocked
            : "";
  const canAsk = AI_FIXES.has(code) && Boolean(ai);
  const canType = TERMINAL_FIXES.has(code);
  // The one filled button: keeping files out comes first, then the AI, else the terminal.
  const primary =
    loose.length && !tracked.length ? "keep" : canAsk ? "ai" : "myself";
  const keepOut = () =>
    void run(
      async () => {
        const change = await api<Change>("secrets/keep-out", {
          id: node.id,
          files: loose.map((file) => file.path),
        });
        changed(change, fix.keptOut, loose.map((file) => file.path).join(", "));
        setAttempt((n) => n + 1);
      },
      fix.keeping,
      { history: true },
    );
  const askAi = () => {
    close();
    void askFix(node.id, code);
  };
  const myself = () => {
    close();
    void openTerminal(node.id, "fix", code).then((opened) => {
      if (opened) toast(fix.started, fix.startedHint);
    });
  };
  const list = (items: { path: string }[]) => (
    <ul className="s-files">
      {items.slice(0, SHOWN).map((file) => (
        <li key={file.path} className="s-mono">
          {file.path}
        </li>
      ))}
      {items.length > SHOWN || more ? (
        <li className="s-quiet">{fix.more(Math.max(0, items.length - SHOWN) + more)}</li>
      ) : null}
    </ul>
  );
  return (
    <Sheet
      title={fix.titles[code]?.(node.label) ?? node.label}
      description={fix.intros[code]}
      onClose={close}
      footer={
        <Button kind="text" onClick={close}>
          {blocks.cancel}
        </Button>
      }
    >
      {checks ? (
        <section
          className="s-fix-secrets"
          aria-labelledby="fix-secrets"
          aria-busy={check.state === "checking"}
        >
          <h3 id="fix-secrets">{fix.secretsTitle}</h3>
          {check.state === "checking" ? (
            <p className="s-working" role="status">
              <span className="s-spinner" aria-hidden="true" />
              {fix.checking}
            </p>
          ) : check.state === "failed" ? (
            <>
              <Callout tone="soon">{fix.failed}</Callout>
              <p className="s-quiet">{check.error}</p>
              <Button
                kind="outline"
                small
                icon="refresh-cw"
                onClick={() => setAttempt((n) => n + 1)}
              >
                {fix.tryAgain}
              </Button>
            </>
          ) : !files.length ? (
            <Callout tone="safe">{fix.clean}</Callout>
          ) : (
            <>
              {tracked.length ? (
                <div className="s-fix-found">
                  <Callout tone="act">{fix.tracked}</Callout>
                  {list(tracked)}
                  <p>{fix.trackedNext}</p>
                </div>
              ) : null}
              {loose.length ? (
                <div className="s-fix-found">
                  <Callout tone="soon">{fix.found}</Callout>
                  {list(loose)}
                  <Button
                    kind={primary === "keep" ? "filled" : "outline"}
                    icon="key-round"
                    disabled={historyPending}
                    onClick={keepOut}
                  >
                    {fix.keepOut}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      {code === "dirty" ? <ChangedFiles node={node} /> : null}
      <div className="s-choices">
        {AI_FIXES.has(code) ? (
          <div className="s-choice">
            <Button
              kind={primary === "ai" ? "filled" : "outline"}
              icon="sparkles"
              disabled={!canAsk}
              onClick={askAi}
            >
              {ai ? fix.askAi(ai) : fix.askAnyAi}
            </Button>
            <p className="s-quiet">
              {canAsk ? (
                <>
                  <span className="s-tag s-tag-brand">{fix.recommended}</span>{" "}
                  {fix.aiNote}
                </>
              ) : (
                fix.noAi
              )}
            </p>
          </div>
        ) : null}
        {canType ? (
          <div className="s-choice">
            <Button
              kind={primary === "myself" ? "filled" : "outline"}
              icon="terminal"
              disabled={Boolean(blocked)}
              onClick={myself}
            >
              {fix.myselfFor[code] ?? fix.myself}
            </Button>
            <p className="s-quiet">{blocked || fix.myselfNote}</p>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

/** "See what changed": the changed files, from the project's health. */
function ChangedFiles({ node }: { node: Node }) {
  const loaded = useHealth(node);
  const health = loaded?.health;
  return (
    <Disclosure label={fix.whatChanged} openLabel={fix.whatChanged}>
      {!loaded ? (
        <p className="s-quiet">{said.safe.loading}</p>
      ) : !health ? (
        <p className="s-quiet">{said.safe.noDetails}</p>
      ) : (
        <ul className="s-files">
          {health.changes.slice(0, 12).map((change) => (
            <li key={change.path}>
              <span className="s-tag">{said.safe.tags[change.code] ?? change.code}</span>{" "}
              <span className="s-mono">{change.path}</span>
            </li>
          ))}
          {health.changes.length > 12 || health.changesMore ? (
            <li className="s-quiet">
              {said.safe.changedMore(
                Math.max(0, health.changes.length - 12) + (health.changesMore ?? 0),
              )}
            </li>
          ) : null}
        </ul>
      )}
    </Disclosure>
  );
}

/** The icon on a fix button, for the fixes that upload or download. */
export const fixIcon = (code: string) =>
  code === "no-remote" || code === "unpushed"
    ? "cloud-upload"
    : code === "behind"
      ? "cloud-download"
      : code === "diverged"
        ? "sparkles"
        : undefined;

/** Opens what fixes `code` on the project: the sheet, or for out of sync, the AI straight away. */
export function startFix(node: Node, code: string) {
  if (code === "diverged") void askFix(node.id, code);
  else useSimple.setState({ fixing: { id: node.id, code } });
}
