// Help, in both designs: a page in Simple (view "help") and a dialog in Detailed (modal "help"). The
// same four parts: how Laci keeps work safe, the words it uses (the glossary in words.ts), the
// keyboard shortcuts of this system (shortcuts.ts) and where to report a problem.
import { useState } from "react";
import { DialogFrame } from "./dialogs";
import { Icon } from "./common";
import { OS } from "./platform";
import { chordText, shortcutsFor } from "./shortcuts";
import type { Shortcut } from "./shortcuts";
import { urlOpen, useApp } from "./store";
import { findTerms, glossary, help } from "./words";

/** One shortcut's keys: each way to press it, its keys as the system writes them. */
function Keys({ shortcut }: { shortcut: Shortcut }) {
  return (
    <span className="help-keys">
      {shortcut.chords.map((chord, i) => (
        <span key={i}>
          {i ? <span className="help-or"> or </span> : null}
          <kbd>{chordText(OS, chord)}</kbd>
        </span>
      ))}
    </span>
  );
}

const report = () => urlOpen(help.reportUrl);

/** Simple's Help page. */
export function HelpPage() {
  const [query, setQuery] = useState("");
  const terms = findTerms(query);
  const keys = shortcutsFor(OS, "simple");
  return (
    <div className="s-page s-help">
      <header className="s-head">
        <h1>{help.title}</h1>
        <p className="s-lead">{help.intro}</p>
      </header>
      <section className="s-card" aria-labelledby="help-safe">
        <header className="s-card-head">
          <Icon name="shield-check" />
          <h2 id="help-safe">{help.safeTitle}</h2>
        </header>
        <ul className="s-help-list">
          {help.safe.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <section className="s-card" aria-labelledby="help-words">
        <header className="s-card-head">
          <Icon name="book-open" />
          <h2 id="help-words">{help.wordsTitle}</h2>
        </header>
        <p className="s-quiet">{help.wordsIntro}</p>
        <label className="s-field s-help-find">
          <span>{help.find}</span>
          <input
            type="search"
            className="s-input"
            value={query}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <dl className="s-glossary">
          {terms.map((t) => (
            <div key={t.id} className="s-glossary-row">
              <dt>{t.term}</dt>
              <dd>
                {t.info}
                <span className="s-quiet s-glossary-was">{help.wordsWas(t.was)}</span>
              </dd>
            </div>
          ))}
        </dl>
        {!terms.length ? <p className="s-quiet">{help.noTerm(query.trim())}</p> : null}
      </section>
      <section className="s-card" aria-labelledby="help-keys">
        <header className="s-card-head">
          <Icon name="keyboard" />
          <h2 id="help-keys">{help.keysTitle}</h2>
        </header>
        <p className="s-quiet">{help.keysIntro}</p>
        <table className="s-keys">
          <tbody>
            {keys.map((shortcut) => (
              <tr key={shortcut.id}>
                <th scope="row">{shortcut.does}</th>
                <td>
                  <Keys shortcut={shortcut} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="s-card" aria-labelledby="help-report">
        <header className="s-card-head">
          <Icon name="message-square" />
          <h2 id="help-report">{help.reportTitle}</h2>
        </header>
        <p>{help.reportBody}</p>
        <div className="s-actions">
          <button type="button" className="s-btn s-btn-outline" onClick={report}>
            <Icon name="external-link" />
            {help.reportLink}
          </button>
        </div>
      </section>
    </div>
  );
}

/** Detailed's Help: the same parts in a dialog, drawn with Detailed's own styles. */
export function HelpDialog() {
  const close = () => useApp.setState({ modal: null });
  const keys = shortcutsFor(OS, "detailed");
  return (
    <DialogFrame
      title={help.title}
      description={help.intro}
      footer={
        <>
          <span className="grow" />
          <button className="btn primary" onClick={close}>
            {help.done}
          </button>
        </>
      }
    >
      <div className="sec-t">{help.safeTitle}</div>
      <ul className="history-paths">
        {help.safe.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="sec-t">{help.keysTitle}</div>
      <div className="short-sec">
        {keys.map((shortcut) => (
          <div className="short-row" key={shortcut.id}>
            <span>{shortcut.does}</span>
            <Keys shortcut={shortcut} />
          </div>
        ))}
      </div>
      <div className="sec-t">{help.wordsTitle}</div>
      <p className="faint">{help.wordsIntro}</p>
      <dl className="kv">
        {glossary.map((t) => (
          <div key={t.id} className="kv-fragment">
            <dt>{t.term}</dt>
            <dd>
              {t.info} <span className="faint">{help.wordsWas(t.was)}</span>
            </dd>
          </div>
        ))}
      </dl>
      <div className="sec-t">{help.reportTitle}</div>
      <p>
        {help.reportBody}{" "}
        <button className="linkbtn" onClick={report}>
          {help.reportLink}
        </button>
      </p>
    </DialogFrame>
  );
}
