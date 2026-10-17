// The places that come in the next build of Simple: a calm card saying what will be there, and the
// way to the same things in Detailed view meanwhile.
import { setDesign } from "../store";
import { later } from "../words";
import { Art } from "./art";
import type { ArtName } from "./art";
import { Button } from "./ui";

type Place = keyof typeof later.titles;

const ART: Record<Place, ArtName> = {
  helpers: "no-chats",
  cleanup: "nothing-to-clean",
  activity: "no-summaries",
  settings: "welcome",
};

export function Later({ place }: { place: Place }) {
  return (
    <div className="s-page s-later-page">
      <header className="s-head">
        <h1>{later.titles[place]}</h1>
      </header>
      <section className="s-card s-later" aria-label={later.titles[place]}>
        <Art name={ART[place]} />
        <div className="s-later-text">
          <p className="s-later-what">{later.bodies[place]}</p>
          <p className="s-quiet">{later.soon}</p>
          <div className="s-actions">
            <Button
              kind="filled"
              icon="panels-top-left"
              onClick={() => setDesign("detailed")}
            >
              {later.open}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
