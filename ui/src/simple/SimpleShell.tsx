import { useApp, setDesign } from "../store";
/**
 * Simple's window, a stand-in until the design is built. Nothing switches to it yet; the browser
 * preview can, with ?design=simple.
 */
export default function SimpleShell() {
  const covered = useApp((s) => Boolean(s.modal || s.palette || s.working));
  return (
    <main id="main" className="boot" tabIndex={-1} inert={covered}>
      <div>
        <b>Simple view isn’t ready yet</b>
        <p>Laci shows your projects in Detailed view until it is.</p>
        <button className="btn" onClick={() => setDesign("detailed")}>
          Use Detailed view
        </button>
      </div>
    </main>
  );
}
