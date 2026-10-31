import React from "react";

/** Eshlik's mark: an "E" of three bars, each cut on the diagonal at its right
 *  end, the middle one shorter. Drawn in a 140×135 box. */
export const MARK_PATH =
  "M0 0H140L109 31H0Z M0 52H104L73 83H0Z M0 104H140L109 135H0Z";
export const MARK_VIEWBOX = "0 0 140 135";

interface ElchiMarkProps {
  /** Width in px; the height follows the mark's 140:135 proportions. */
  size?: number;
  /** Fill (any CSS color). Defaults to the current text color. */
  color?: string;
  className?: string;
}

const ElchiMark: React.FC<ElchiMarkProps> = ({
  size = 16,
  color = "currentColor",
  className,
}) => (
  <svg
    width={size}
    height={(size * 135) / 140}
    viewBox={MARK_VIEWBOX}
    className={className}
    aria-hidden="true"
  >
    <path d={MARK_PATH} style={{ fill: color }} />
  </svg>
);

export default ElchiMark;
