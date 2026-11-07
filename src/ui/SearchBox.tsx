import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { goToNamed } from "../controller";
import { type SearchResult, searchPlaces } from "../weather/provider";

type SearchStatus = "idle" | "searching" | "done" | "error";

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

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

  const choose = (result: SearchResult) => {
    goToNamed(result.lat, result.lon, result.name, result.country);
    setOpen(false);
    setQuery("");
    setPendingEnter(false);
    inputRef.current?.blur();
  };

  const activeResult = results[active];

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the awaited results land.
  useEffect(() => {
    if (!pendingEnter || status === "searching") return;
    setPendingEnter(false);
    const first = results[0];
    if (status === "done" && first) choose(first);
  }, [pendingEnter, status, results]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // The first press closes the list, the next clears the text.
      event.preventDefault();
      if (open && query) setOpen(false);
      else {
        setQuery("");
        setPendingEnter(false);
      }
    } else if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % results.length);
    } else if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // While searching, the list still shows results for the previous text.
      if (status === "done" && activeResult) choose(activeResult);
      else if (
        status === "searching" ||
        (status === "idle" && query.trim().length >= MIN_QUERY_LENGTH)
      ) {
        setPendingEnter(true);
      }
    }
  };

  const showList = open && query.trim().length >= MIN_QUERY_LENGTH;

  return (
    <div className="search">
      <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        placeholder="Search for a place"
        aria-label="Search for a place"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={showList && activeResult ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <div className="search-results">
          {results.length > 0 && (
            <div id={listId} role="listbox" aria-label="Places">
              {results.map((result, i) => (
                <button
                  key={result.id}
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  // The input keeps focus; arrow keys move the highlight through aria-activedescendant.
                  tabIndex={-1}
                  aria-selected={i === active}
                  className={i === active ? "search-option is-active" : "search-option"}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(result)}
                >
                  <span className="search-name">{result.name}</span>
                  <span className="search-region">
                    {[result.admin, result.country].filter(Boolean).join(", ")}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div role="status" className="search-status">
            {status === "searching" && results.length === 0 && "Searching…"}
            {status === "done" && results.length === 0 && "No places found"}
            {status === "error" && "Search isn't available right now"}
          </div>
        </div>
      )}
    </div>
  );
}
