import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { forgetRecent, goToNamed, goToSaved } from "../controller";
import { zoneFor } from "../geo/timezone";
import type { SavedPlace } from "../savedPlaces";
import { useStore } from "../store";
import { type SearchResult, searchPlaces } from "../weather/provider";
import { flagEmoji } from "./flags";
import { useNow } from "./hooks";
import { Icon } from "./panel/Icon";
import { formatShortTime } from "./time";

type SearchStatus = "idle" | "searching" | "done" | "error";

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

interface Option {
  key: string;
  group: "result" | "saved" | "recent";
  name: string;
  detail: string;
  zone: string;
  flag: string;
  go: () => void;
}

/** True when the key was pressed while typing somewhere, so "/" should type a slash. */
function typingIn(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    !!element &&
    (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName))
  );
}

export function SearchBox() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** Enter was pressed before the results arrived; take the first one when they do. */
  const [pendingEnter, setPendingEnter] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const favorites = useStore((s) => s.favorites);
  const recents = useStore((s) => s.recents);
  const hour12 = useStore((s) => s.settings.hour12);
  // The local times beside each place only need to tick while the list is open.
  const now = useNow(open);

  // "/" anywhere focuses the search, as on many sites.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (typingIn(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const text = query.trim();
    if (text.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    setStatus("searching");
    const timer = setTimeout(() => {
      searchPlaces(text, controller.signal).then(
        (found) => {
          if (controller.signal.aborted) return;
          setResults(found);
          setActive(0);
          setStatus("done");
        },
        () => {
          if (controller.signal.aborted) return;
          setResults([]);
          setStatus("error");
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setPendingEnter(false);
    inputRef.current?.blur();
  };

  const searching = query.trim().length >= MIN_QUERY_LENGTH;
  const options = useMemo<Option[]>(() => {
    if (searching) {
      return results.map((r) => ({
        key: `result-${r.id}`,
        group: "result",
        name: r.name,
        detail: [r.admin, r.country].filter(Boolean).join(", "),
        zone: r.timezone,
        flag: flagEmoji(r.countryCode),
        go: () => goToNamed(r.lat, r.lon, r.name, r.country),
      }));
    }
    const fromSaved = (group: "saved" | "recent") => (p: SavedPlace) => ({
      key: `${group}-${p.lat},${p.lon}`,
      group,
      name: p.name,
      detail: p.region,
      zone: zoneFor(p.lat, p.lon, false),
      flag: "",
      go: () => goToSaved(p),
    });
    return [...favorites.map(fromSaved("saved")), ...recents.map(fromSaved("recent"))];
  }, [searching, results, favorites, recents]);

  const choose = (option: Option) => {
    option.go();
    close();
  };

  const activeOption = options[active];

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the awaited results land.
  useEffect(() => {
    if (!pendingEnter || status === "searching") return;
    setPendingEnter(false);
    const first = options[0];
    if (status === "done" && first) choose(first);
  }, [pendingEnter, status, options]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // The first press closes the list, the next clears the text.
      event.preventDefault();
      if (open && (query || options.length)) setOpen(false);
      else {
        setQuery("");
        setPendingEnter(false);
        inputRef.current?.blur();
      }
    } else if (event.key === "ArrowDown" && options.length) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % options.length);
    } else if (event.key === "ArrowUp" && options.length) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // While searching, the list still shows results for the previous text.
      if (activeOption && (!searching || status === "done")) choose(activeOption);
      else if (searching && status !== "error") setPendingEnter(true);
    }
  };

  const showList = open && (searching || options.length > 0);

  return (
    <div className="search">
      <span className="search-icon">
        <Icon name="search" />
      </span>
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        placeholder="Search for a place"
        aria-label="Search for a place"
        aria-keyshortcuts="/"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={showList && activeOption ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => {
          setActive(0);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <span className="search-shortcut" aria-hidden="true">
        /
      </span>
      {showList && (
        <div className="search-results">
          {options.length > 0 && (
            <div id={listId} role="listbox" aria-label="Places">
              {(["result", "saved", "recent"] as const).map((group) => {
                const members = options.filter((o) => o.group === group);
                if (members.length === 0) return null;
                const title =
                  group === "saved" ? "Saved places" : group === "recent" ? "Recent" : "";
                return (
                  // A fieldset would be wrong inside a listbox, which groups its options this way.
                  // biome-ignore lint/a11y/useSemanticElements: listbox option groups are role="group".
                  <div
                    key={group}
                    role="group"
                    aria-label={title || "Search results"}
                    className="search-group"
                  >
                    {title && (
                      <div className="search-heading" aria-hidden="true">
                        {title}
                      </div>
                    )}
                    {members.map((option) => {
                      const i = options.indexOf(option);
                      return (
                        <button
                          key={option.key}
                          id={`${listId}-${i}`}
                          type="button"
                          role="option"
                          // The input keeps focus; arrow keys move the highlight through aria-activedescendant.
                          tabIndex={-1}
                          aria-selected={i === active}
                          className={i === active ? "search-option is-active" : "search-option"}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseMove={() => setActive(i)}
                          onClick={() => choose(option)}
                        >
                          <span className="search-flag" aria-hidden="true">
                            {option.flag ||
                              (option.group === "saved" ? (
                                <Icon name="star" filled />
                              ) : (
                                <Icon name="clock" />
                              ))}
                          </span>
                          <span className="search-text">
                            <span className="search-name">{option.name}</span>
                            {option.detail && (
                              <span className="search-region">{option.detail}</span>
                            )}
                          </span>
                          <span className="search-time">
                            {option.zone ? formatShortTime(now, option.zone, hour12) : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
          {!searching && recents.length > 0 && (
            <button
              type="button"
              className="link-button search-clear"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                for (const p of recents) forgetRecent(p);
                setActive(0);
              }}
            >
              Clear recent places
            </button>
          )}
          <div role="status" className="search-status">
            {searching && status === "searching" && results.length === 0 && "Searching…"}
            {searching && status === "done" && results.length === 0 && "No places found"}
            {searching && status === "error" && "Search isn't available right now"}
          </div>
        </div>
      )}
    </div>
  );
}
