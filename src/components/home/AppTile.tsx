import React from "react";
import ElchiMark from "../icons/ElchiMark";

/** Hues of the apps people dictate into most, so each keeps its familiar
 *  colour; `null` is a neutral (graphite) tile. Any other app gets a hue from
 *  its name, so it keeps its colour too. */
const APP_HUES: Record<string, number | null> = {
  mail: 218,
  slack: 282,
  cursor: null,
  "vs code": 205,
  code: 205,
  chrome: 215,
  "google chrome": 215,
  safari: 208,
  notes: 45,
  notlar: 45,
  whatsapp: 140,
  telegram: 198,
  word: 220,
  "microsoft word": 220,
  outlook: 206,
  "microsoft outlook": 206,
  teams: 238,
  "microsoft teams": 238,
  notion: null,
  terminal: null,
  messages: 135,
  mesajlar: 135,
};

const hueOf = (name: string): number | null => {
  const known = APP_HUES[name.toLowerCase()];
  if (known !== undefined) return known;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

/** Dark: a deep tint with a pale glyph. Light: a lit gradient, white glyph
 *  (dark on yellows, where white would not read). */
const tileColors = (hue: number | null, dark: boolean) => {
  if (hue === null)
    return dark
      ? { bg: "#141418", fg: "#ECECEE" }
      : { bg: "linear-gradient(180deg,#3A3A42,#1E1E24)", fg: "#fff" };
  if (dark) return { bg: `hsl(${hue} 58% 14%)`, fg: `hsl(${hue} 100% 87%)` };
  const yellow = hue >= 35 && hue <= 70;
  return yellow
    ? {
        bg: `linear-gradient(180deg,hsl(${hue} 100% 65%),hsl(${hue} 80% 51%))`,
        fg: "#2B2000",
      }
    : {
        bg: `linear-gradient(180deg,hsl(${hue} 72% 58%),hsl(${hue} 66% 42%))`,
        fg: "#fff",
      };
};

const tileShadow = (dark: boolean) =>
  dark
    ? "inset 0 1px 0 rgba(255,255,255,.18), inset 0 -1px 0 rgba(0,0,0,.5)"
    : "inset 0 1px 0 rgba(255,255,255,.3), 0 1px 2px rgba(0,0,0,.2)";

const TILE = "flex-none size-9 rounded-[9px] grid place-items-center";

/** The 36px tile beside a dictation: the app's own icon when the OS gives
 *  one, else its initial on the app's colour. */
export const AppTile: React.FC<{
  app?: string | null;
  icon?: string;
  dark: boolean;
}> = ({ app, icon, dark }) => {
  if (icon)
    return (
      <img
        src={icon}
        alt=""
        aria-hidden="true"
        className="flex-none size-9 object-contain"
        draggable={false}
      />
    );
  const { bg, fg } = tileColors(app ? hueOf(app) : null, dark);
  return (
    <span
      aria-hidden="true"
      className={`${TILE} font-medium text-[13px] ${dark ? "border border-white/10" : ""}`}
      style={{ background: bg, color: fg, boxShadow: tileShadow(dark) }}
    >
      {app?.trim()[0]?.toUpperCase() ?? ""}
    </span>
  );
};

/** Eshlik's own tile: the E mark on a blue tint. */
export const ElchiTile: React.FC<{ dark: boolean }> = ({ dark }) => (
  <span
    aria-hidden="true"
    className={`${TILE} bg-accent/15 border border-text/10 text-logo-primary`}
    style={{ boxShadow: tileShadow(dark) }}
  >
    <ElchiMark size={13} />
  </span>
);
