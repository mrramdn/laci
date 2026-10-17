import { useId } from "react";
import { MARK, MARK_16, MARK_24 } from "./brand-marks";
/**
 * Laci's mark, drawn inline. At 24 px and below, standard screens get the version drawn on the pixel grid
 * (a scaled master blurs there); dense screens and larger sizes get the vector master.
 */
export function LaciMark({ size = 24, label }: { size?: number; label?: string }) {
  // Each copy needs its own gradient id: a gradient inside a hidden copy would not paint the others.
  const id = `laci-plate-${useId().replace(/[^\w-]/g, "")}`;
  const vector = MARK.replaceAll('"plate"', `"${id}"`).replaceAll(
    "url(#plate)",
    `url(#${id})`,
  );
  const pixel = size <= 16 ? MARK_16 : size <= 24 ? MARK_24 : null;
  return (
    <span
      className="lacimark"
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {pixel ? (
        <span className="px" dangerouslySetInnerHTML={{ __html: pixel }} />
      ) : null}
      <span
        className={pixel ? "vec" : undefined}
        dangerouslySetInnerHTML={{ __html: vector }}
      />
    </span>
  );
}
