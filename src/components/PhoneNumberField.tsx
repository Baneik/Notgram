import { Check, ChevronDown, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent,
} from "react";
import {
  composePhoneNumber,
  defaultPhoneCountry,
  filterPhoneCountries,
  type PhoneCountry,
} from "./phoneCountries";

interface PhoneNumberFieldProps {
  disabled?: boolean;
  onChange: (phoneNumber: string) => void;
}

export function PhoneNumberField({ disabled = false, onChange }: PhoneNumberFieldProps) {
  const [country, setCountry] = useState(defaultPhoneCountry);
  const [nationalNumber, setNationalNumber] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const countryInputRef = useRef<HTMLInputElement>(null);
  const filteredCountries = useMemo(() => filterPhoneCountries(query), [query]);

  useEffect(() => {
    onChange(composePhoneNumber(country, nationalNumber));
  }, [country, nationalNumber, onChange]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const activeCountry = filteredCountries[activeIndex];
    if (!activeCountry) return;
    rootRef.current?.querySelector(`#auth-country-${activeCountry.code}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filteredCountries, open]);

  const openCountries = useCallback(() => {
    if (disabled) return;
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }, [disabled]);

  const toggleCountries = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    openCountries();
    requestAnimationFrame(() => countryInputRef.current?.focus());
  }, [open, openCountries]);

  const chooseCountry = useCallback((nextCountry: PhoneCountry) => {
    setCountry(nextCountry);
    setQuery("");
    setOpen(false);
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLInputElement>(".auth-national-number")?.focus();
    });
  }, []);

  const handleCountryKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) openCountries();
      else setActiveIndex((index) => Math.min(index + 1, filteredCountries.length - 1));
      return;
    }
    if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Enter" && open && filteredCountries[activeIndex]) {
      event.preventDefault();
      chooseCountry(filteredCountries[activeIndex]);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }, [activeIndex, chooseCountry, filteredCountries, open, openCountries]);

  const updateQuery = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    setOpen(true);
  }, []);

  const updateNationalNumber = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setNationalNumber(event.target.value.replace(/[^\d\s()-]/g, ""));
  }, []);

  const closeCountriesOnBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }, []);

  const activateCountryOption = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    setActiveIndex(Number(event.currentTarget.dataset.index ?? 0));
  }, []);

  const selectCountryOption = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const option = filteredCountries.find(
      (candidate) => candidate.code === event.currentTarget.dataset.countryCode,
    );
    if (option) chooseCountry(option);
  }, [chooseCountry, filteredCountries]);

  return (
    <div className="auth-phone-field">
      <span className="auth-phone-label">手机号码</span>
      <div className="auth-phone-row" ref={rootRef}>
        <div className={`auth-country-picker ${open ? "is-open" : ""}`} onBlur={closeCountriesOnBlur}>
          <Search className="auth-country-search-icon" size={15} />
          <input
            ref={countryInputRef}
            className="auth-country-input"
            type="text"
            role="combobox"
            aria-label="国家或地区"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls="auth-country-options"
            aria-activedescendant={open && filteredCountries[activeIndex]
              ? `auth-country-${filteredCountries[activeIndex].code}`
              : undefined}
            autoComplete="off"
            disabled={disabled}
            value={open ? query : country.name}
            placeholder="国家或区号"
            onFocus={openCountries}
            onChange={updateQuery}
            onKeyDown={handleCountryKeyDown}
          />
          {!open && <span className="auth-country-code">+{country.callingCode}</span>}
          <button
            className="auth-country-toggle"
            type="button"
            tabIndex={-1}
            aria-label="展开国家或地区"
            title="选择国家或地区"
            disabled={disabled}
            onClick={toggleCountries}
          >
            <ChevronDown size={15} />
          </button>

          {open && (
            <div className="auth-country-options" id="auth-country-options" role="listbox" aria-label="国家或地区列表">
              {filteredCountries.length > 0 ? filteredCountries.map((option, index) => (
                <button
                  key={option.code}
                  id={`auth-country-${option.code}`}
                  className={`auth-country-option ${index === activeIndex ? "is-active" : ""}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={option.code === country.code}
                  data-index={index}
                  data-country-code={option.code}
                  onPointerMove={activateCountryOption}
                  onClick={selectCountryOption}
                >
                  <span><strong>{option.name}</strong><small>{option.code}</small></span>
                  <span>+{option.callingCode}</span>
                  {option.code === country.code && <Check size={15} />}
                </button>
              )) : (
                <div className="auth-country-empty">没有匹配的国家或区号</div>
              )}
            </div>
          )}
        </div>

        <input
          className="auth-national-number"
          type="tel"
          inputMode="tel"
          autoFocus
          autoComplete="tel-national"
          aria-label="号码"
          placeholder="手机号码"
          maxLength={24}
          required
          disabled={disabled}
          value={nationalNumber}
          onChange={updateNationalNumber}
        />
      </div>
    </div>
  );
}
