import React from "react";
import ElchiMark from "./ElchiMark";

// Product name; never translated.
const PRODUCT_NAME = "Eshlik";

interface ElchiLogoProps {
  /** Wordmark size in px; the mark scales with it. */
  size?: number;
  /** Ink for the mark and the letters (defaults to the text color). */
  color?: string;
  className?: string;
}

/** Eshlik wordmark: the E mark beside "Eshlik" in Geist. */
const ElchiLogo: React.FC<ElchiLogoProps> = ({
  size = 15,
  color = "var(--color-text)",
  className = "",
}) => (
  <div
    className={`inline-flex items-center select-none ${className}`}
    style={{ gap: size * 0.74 }}
    role="img"
    aria-label={PRODUCT_NAME}
  >
    {/* The mark keeps the share of the wordmark it had beside "Elchi" (1.05 and a
        0.6 gap); "Eshlik" sets 23% wider, so both grew by as much. */}
    <ElchiMark size={size * 1.29} color={color} />
    <span
      aria-hidden="true"
      className="font-sans font-medium leading-none"
      style={{ fontSize: size, letterSpacing: "-0.01em", color }}
    >
      {PRODUCT_NAME}
    </span>
  </div>
);

export default ElchiLogo;
