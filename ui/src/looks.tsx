// How each design looks, for the places where someone chooses one: the first-run screen, Settings ›
// Appearance in Detailed and the card on Detailed's Today that offers Simple. Their styles, and the
// toggle's at the foot of Detailed's sidebar, are in styles/looks.css, which palette.tsx brings into
// the first chunk.
import { useId } from "react";
import { Icon } from "./common";
import type { Design } from "./types";
import { views } from "./words";

/** The two designs, in the order they are offered: Simple first, as the one recommended. */
export const DESIGNS: readonly Design[] = ["simple", "detailed"];

/**
 * A small picture of a design's window, in that design's own colours for the theme shown. It only
 * decorates: the words beside it say which design it is.
 */
export function LookThumb({ design }: { design: Design }) {
  return (
    <svg
      className={`look-thumb ${design}`}
      viewBox="0 0 160 100"
      aria-hidden="true"
      focusable="false"
    >
      {design === "simple" ? <SimpleArt /> : <DetailedArt />}
    </svg>
  );
}

/** Simple: five places, a greeting, one card with one filled button, and calm lists beside it. */
function SimpleArt() {
  return (
    <>
      <rect className="lk-frame" x="0.5" y="0.5" width="159" height="99" rx="7" />
      <path className="lk-rule" d="M37.5 1v98" />
      <rect className="lk-sand" x="7" y="7" width="8" height="8" rx="2.5" />
      <rect className="lk-ink" x="18" y="9.5" width="12" height="3" rx="1.5" />
      <rect className="lk-soft" x="5" y="21" width="28" height="9" rx="3" />
      <rect className="lk-brand" x="9" y="24.5" width="13" height="2.5" rx="1.25" />
      {[35, 45, 55, 65].map((y) => (
        <rect key={y} className="lk-text" x="9" y={y} width="17" height="2.5" rx="1.25" />
      ))}
      <rect className="lk-ink" x="45" y="9" width="42" height="5" rx="2.5" />
      <rect className="lk-text" x="45" y="17" width="26" height="2.5" rx="1.25" />
      <rect className="lk-card" x="45.5" y="25.5" width="73" height="33" rx="5" />
      <rect className="lk-ink" x="52" y="32" width="42" height="3.5" rx="1.75" />
      <rect className="lk-text" x="52" y="39" width="56" height="2.5" rx="1.25" />
      <rect className="lk-brand" x="52" y="46" width="25" height="7" rx="3.5" />
      {[63.5, 78.5].map((y) => (
        <g key={y}>
          <rect className="lk-card" x="45.5" y={y} width="73" height="11" rx="4" />
          <rect className="lk-ink" x="51" y={y + 4.25} width="18" height="2.5" rx="1.25" />
          <rect className="lk-chip" x="88" y={y + 3} width="24" height="5" rx="2.5" />
        </g>
      ))}
      <rect className="lk-card" x="124.5" y="25.5" width="30" height="19" rx="4" />
      <rect className="lk-ink" x="129" y="31" width="16" height="2.5" rx="1.25" />
      <rect className="lk-text" x="129" y="37" width="20" height="2" rx="1" />
      <rect className="lk-card" x="124.5" y="48.5" width="30" height="41" rx="4" />
      <rect className="lk-ink" x="129" y="54" width="18" height="2.5" rx="1.25" />
      {[60, 65, 70].map((y) => (
        <rect key={y} className="lk-text" x="129" y={y} width="21" height="2" rx="1" />
      ))}
      <rect className="lk-ok" x="129" y="78" width="14" height="6" rx="3" />
    </>
  );
}

/** The dots of Detailed's rows: a problem, something to do soon, and fine. */
const ROW_TONES = ["lk-risk", "lk-attention", "lk-attention", "lk-ok"];

/** Detailed: a sidebar of places, long rows with their badges, and the details beside them. */
function DetailedArt() {
  const rows = [14, 20.5, 27, 33.5, 46.5, 53, 59.5, 66, 72.5, 85.5, 92];
  return (
    <>
      <rect className="lk-frame" x="0.5" y="0.5" width="159" height="99" rx="7" />
      <path className="lk-side" d="M1 8a7 7 0 0 1 7-7h22v98H8a7 7 0 0 1-7-7z" />
      <path className="lk-rule" d="M30.5 1v98M119.5 1v98M31 9.5h88" />
      <rect className="lk-brand" x="4" y="6" width="5" height="5" rx="1.5" />
      <rect className="lk-soft" x="3" y="15" width="25" height="5" rx="1.5" />
      {[16.5, 23.5, 29.5, 35.5].map((y, i) => (
        <rect
          key={y}
          className={i ? "lk-text" : "lk-ink"}
          x="6"
          y={y}
          width={i ? 14 : 16}
          height="2"
          rx="1"
        />
      ))}
      {[46, 51, 56, 61, 66, 71, 76].map((y, i) => (
        <rect
          key={y}
          className="lk-text"
          x={i % 3 ? 9 : 5}
          y={y}
          width={i % 3 ? 15 : 19}
          height="2"
          rx="1"
        />
      ))}
      <rect className="lk-ink" x="35" y="4" width="17" height="2.5" rx="1.25" />
      <rect className="lk-chip" x="90" y="3.5" width="10" height="3.5" rx="1.75" />
      <rect className="lk-chip" x="103" y="3.5" width="12" height="3.5" rx="1.75" />
      {[40, 79].map((y) => (
        <rect key={y} className="lk-side" x="31" y={y - 1} width="88" height="5" />
      ))}
      {[40, 79].map((y) => (
        <rect key={`h${y}`} className="lk-text" x="35" y={y + 0.5} width="20" height="2" rx="1" />
      ))}
      {rows.map((y, i) => (
        <g key={y}>
          <circle className={ROW_TONES[i % ROW_TONES.length]} cx="35.5" cy={y + 1} r="1.5" />
          <rect className="lk-ink" x="39" y={y} width={12 + (i % 3) * 3} height="2" rx="1" />
          <rect className="lk-chip" x="58" y={y - 0.5} width="13" height="3" rx="1.5" />
          <rect className="lk-text" x="74" y={y} width={18 + (i % 2) * 6} height="2" rx="1" />
          <rect className="lk-text" x="108" y={y} width="7" height="2" rx="1" />
        </g>
      ))}
      <rect className="lk-ink" x="124" y="5" width="22" height="3" rx="1.5" />
      <rect className="lk-brand" x="124" y="14" width="7" height="2" rx="1" />
      {[134, 143].map((x) => (
        <rect key={x} className="lk-text" x={x} y="14" width="6" height="2" rx="1" />
      ))}
      {[24, 30, 36, 42, 48, 54, 60].map((y, i) => (
        <g key={y}>
          <rect className="lk-text" x="124" y={y} width="10" height="2" rx="1" />
          <rect
            className={i === 2 ? "lk-brand" : "lk-ink"}
            x="137"
            y={y}
            width={8 + (i % 3) * 4}
            height="2"
            rx="1"
          />
        </g>
      ))}
    </>
  );
}

/**
 * Simple and Detailed side by side, each with its picture and what it is. In a form (`form`, the
 * first-run screen) they are radio buttons, and nothing changes until the form is saved. Elsewhere
 * they are buttons that switch at once, as the toggle in the sidebar does, so moving between them
 * with the arrow keys never switches by itself.
 */
export function LookPicker({
  value,
  onChange,
  labelledBy,
  form = false,
}: {
  value: Design;
  onChange: (design: Design) => void;
  /** The id of the heading that names the choice. */
  labelledBy: string;
  form?: boolean;
}) {
  const id = useId();
  return (
    <div
      className="look-pick"
      role={form ? "radiogroup" : "group"}
      aria-labelledby={labelledBy}
      data-ui="design-choice"
    >
      {DESIGNS.map((design) => {
        const chosen = value === design;
        const recommended = design === "simple";
        const name = `${id}-${design}`;
        const tag = `${id}-${design}-tag`;
        const about = `${id}-${design}-about`;
        // A screen reader hears the name, then "Recommended" and what the design is.
        const described = recommended ? `${tag} ${about}` : about;
        const text = (
          <>
            <LookThumb design={design} />
            <span className="look-text">
              <span className="look-name" id={name}>
                {views.names[design]}
              </span>
              {recommended ? (
                <span className="look-tag" id={tag}>
                  {views.recommended}
                </span>
              ) : null}
              {!form && chosen ? (
                <span className="look-tag shown">{views.shown}</span>
              ) : null}
              <span className="look-about" id={about}>
                {views.about[design]}
              </span>
            </span>
          </>
        );
        return form ? (
          <label className="look" key={design} data-design={design}>
            <input
              type="radio"
              name={`${id}-design`}
              value={design}
              checked={chosen}
              aria-labelledby={name}
              aria-describedby={described}
              onChange={() => onChange(design)}
            />
            {text}
          </label>
        ) : (
          <button
            type="button"
            className="look"
            key={design}
            data-design={design}
            aria-pressed={chosen}
            aria-labelledby={name}
            aria-describedby={described}
            onClick={() => onChange(design)}
          >
            <span className="look-mark" aria-hidden="true">
              {chosen ? <Icon name="check" /> : null}
            </span>
            {text}
          </button>
        );
      })}
    </div>
  );
}
