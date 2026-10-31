import React from "react";
import { ElchiTile } from "./AppTile";

/** Mono header line of a row: who posted and when. */
export const RowHead: React.FC<{
  name: string;
  when: string;
  children?: React.ReactNode;
}> = ({ name, when, children }) => (
  <div className="flex items-baseline gap-2.5 min-w-0 font-mono text-[11px] tracking-[0.04em] text-[color:var(--text-faint)]">
    <span className="text-text/80 truncate">{name}</span>
    <span className="uppercase whitespace-nowrap">{when}</span>
    {children}
  </div>
);

/** A steel chip action (KOPYALA, DÜZENLE…). */
export const ChipButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement>
> = ({ className = "", children, ...props }) => (
  <button
    type="button"
    {...props}
    className={`steel-chip px-[9px] py-[5px] font-mono text-[10px] leading-none tracking-[0.06em] uppercase whitespace-nowrap cursor-pointer hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50 disabled:cursor-default ${className}`}
  >
    {children}
  </button>
);

/** A borderless mono action (VAZGEÇ, BİR DAHA GÖSTERME). */
export const GhostButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement>
> = ({ className = "", children, ...props }) => (
  <button
    type="button"
    {...props}
    className={`px-[9px] py-[5px] rounded-md font-mono text-[10px] leading-none tracking-[0.06em] uppercase whitespace-nowrap text-[color:var(--text-faint)] hover:text-text cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${className}`}
  >
    {children}
  </button>
);

/** One of Eshlik's own posts in the feed: a word it learned, a streak, a
 *  milestone, the trial ending. The title is in the accent ink. */
export const ElchiPost: React.FC<{
  when: string;
  title: string;
  body?: React.ReactNode;
  actions?: React.ReactNode;
  dark: boolean;
}> = ({ when, title, body, actions, dark }) => (
  <article className="grid grid-cols-[36px_minmax(0,1fr)] gap-4 py-[18px] hairline-t">
    <ElchiTile dark={dark} />
    <div className="flex flex-col gap-[7px] min-w-0">
      <RowHead name="Eshlik" when={when} />
      <p className="text-[16px] leading-[1.45] tracking-[-0.005em] [text-wrap:pretty]">
        <span className="text-logo-primary">{title}</span>
        {body && <> {body}</>}
      </p>
      {actions && <div className="flex items-center gap-1.5">{actions}</div>}
    </div>
  </article>
);
