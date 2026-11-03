import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { goToNamed } from '../controller';
import { searchPlaces, type SearchResult } from '../weather/provider';

type SearchStatus = 'idle' | 'searching' | 'done' | 'error';

const DEBOUNCE_MS = 300;

export function SearchBox() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setResults([]);
      setStatus('idle');
      return;
    }
    const controller = new AbortController();
    setStatus('searching');
    const timer = setTimeout(() => {
      searchPlaces(text, controller.signal).then(
        (found) => {
          setResults(found);
          setActive(0);
          setStatus('done');
        },
        () => {
          if (!controller.signal.aborted) setStatus('error');
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
    setQuery('');
    inputRef.current?.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'ArrowDown' && results.length) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length) {
      event.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === 'Enter' && results[active]) {
      event.preventDefault();
      choose(results[active]);
    }
  };

  const showList = open && query.trim().length >= 2;

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
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
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
        <ul id={listId} role="listbox" className="search-results">
          {results.map((result, i) => (
            <li
              key={result.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : undefined}
              // Keeps focus in the input, so the blur does not close the list first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(result)}
            >
              <span className="search-name">{result.name}</span>
              <span className="search-region">
                {[result.admin, result.country].filter(Boolean).join(', ')}
              </span>
            </li>
          ))}
          {status === 'searching' && results.length === 0 && <li className="search-status">Searching…</li>}
          {status === 'done' && results.length === 0 && <li className="search-status">No places found</li>}
          {status === 'error' && <li className="search-status">Search isn't available right now</li>}
        </ul>
      )}
    </div>
  );
}
