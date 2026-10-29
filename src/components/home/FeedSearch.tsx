import React from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";

/** The magnifier at the end of the feed's first day header. */
export const SearchButton: React.FC<{ onClick: () => void }> = ({
  onClick,
}) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("home.search.open")}
      title={t("home.search.open")}
      className="-my-1.5 size-6 grid place-items-center rounded-md text-text/40 hover:text-text hover:bg-text/[0.06] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <Search size={13} strokeWidth={2} />
    </button>
  );
};

/** The search field the magnifier opens, in place of the day header. Escape
 *  or × clears and closes it. */
export const SearchField: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  /** Matches found, once the search has answered. */
  count: number | null;
  inputRef: React.RefObject<HTMLInputElement>;
}> = ({ value, onChange, onClose, count, inputRef }) => {
  const { t, i18n } = useTranslation();
  return (
    <div className="pt-[18px] pb-2.5">
      <div className="well flex items-center gap-2.5 ps-3 pe-1.5 py-[5px]">
        <Search
          size={14}
          strokeWidth={2}
          aria-hidden="true"
          className="flex-none text-logo-primary"
        />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          autoFocus
          spellCheck={false}
          placeholder={t("home.search.placeholder")}
          aria-label={t("home.search.placeholder")}
          className="flex-1 min-w-0 bg-transparent text-[14px] caret-accent focus:outline-none placeholder:text-mid-gray [&::-webkit-search-cancel-button]:hidden"
        />
        {count !== null && (
          <span
            aria-live="polite"
            className="flex-none font-mono text-[10px] tracking-[0.12em] uppercase text-text/40 whitespace-nowrap"
          >
            {t("home.search.count", {
              count,
              n: new Intl.NumberFormat(i18n.language).format(count),
            })}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("home.search.close")}
          title={t("home.search.close")}
          className="flex-none size-6 grid place-items-center rounded-md text-text/40 hover:text-text hover:bg-text/[0.06] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
};
