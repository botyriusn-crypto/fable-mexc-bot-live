"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, LoaderCircle, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  exchangeLabel,
  filterMarkets,
  type CoinMarket,
} from "@/lib/coin-selector-utils"

interface CoinSelectorProps {
  exchange: string
  value: string
  markets: CoinMarket[] | undefined
  isLoading: boolean
  error?: { message?: string } | null
  disabled?: boolean
  onSelect: (symbol: string) => void
  /** Trigger placeholder when nothing is selected. Defaults to "Select coin". */
  placeholder?: string
  /** Label shown above the trigger. Defaults to "Coin". */
  label?: string
  /** Hide the label row (for tight spots like card headers). Defaults to false. */
  compact?: boolean
  /** Fired when the dropdown opens/closes (e.g. to clear a stale form error). */
  onOpenChange?: (open: boolean) => void
}

/**
 * True exchange-switch-aware coin selector.
 *
 * - `key={exchange}` (set by the parent) or the `exchange` prop drives the
 *   header badge, so the list always belongs to the currently selected
 *   exchange — never a stale cached list from the previous one.
 * - Shows the COMPLETE market list (scrollable); the query only filters.
 * - Clicking a coin calls `onSelect` immediately (auto select/populate).
 */
export function CoinSelector({
  exchange,
  value,
  markets,
  isLoading,
  error,
  disabled,
  onSelect,
  placeholder = "Select coin",
  label = "Coin",
  compact = false,
  onOpenChange,
}: CoinSelectorProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const exchangeName = exchangeLabel(exchange)
  const total = markets?.length ?? 0
  const active = (value || "").toUpperCase()

  // A new exchange means a new list: close the panel and clear the search so
  // the user always starts from the complete list of the current exchange.
  useEffect(() => {
    setOpen(false)
    setQuery("")
  }, [exchange])

  useEffect(() => {
    function handleOutside(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", handleOutside)
    document.addEventListener("keydown", handleKey)
    return () => {
      document.removeEventListener("mousedown", handleOutside)
      document.removeEventListener("keydown", handleKey)
    }
  }, [])

  useEffect(() => {
    onOpenChange?.(open)
    if (open) {
      setQuery("")
      // Let the popover mount before focusing.
      const t = setTimeout(() => searchRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [open ])

  const filtered = useMemo(
    () => filterMarkets(markets ?? [], query),
    [markets, query],
  )

  const handlePick = (symbol: string) => {
    const s = (symbol || "").toUpperCase()
    if (!s || s === active) {
      setOpen(false)
      return
    }
    setOpen(false)
    setQuery("")
    onSelect(s)
  }

  return (
    <div ref={rootRef} className="relative flex min-w-52 flex-1 flex-col gap-1 text-xs text-muted-foreground">
      {!compact && (
        <span className="flex items-center gap-1.5">
          {label}
          <Badge variant="outline" className="px-1.5 text-[10px] font-semibold">
            {exchangeName}
          </Badge>
          {!isLoading && total > 0 && (
            <span className="text-[10px] text-muted-foreground">{total} listed</span>
          )}
        </span>
      )}

      <button
        type="button"
        disabled={disabled || isLoading}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 font-mono text-sm text-foreground shadow-xs transition-colors outline-none hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {compact && (
            <Badge variant="outline" className="shrink-0 px-1.5 font-sans text-[10px] font-semibold">
              {exchangeName}
            </Badge>
          )}
          <span className="truncate">
            {isLoading ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                Loading {exchangeName} coins…
              </span>
            ) : (
              active.replace("_", "/") || placeholder
            )}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute top-full right-0 left-0 z-30 mt-1.5 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
          <div className="border-b border-border bg-muted/40 p-2">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value.toUpperCase())}
                placeholder={`Search ${exchangeName} coins…`}
                autoComplete="off"
                className="h-8 bg-background pr-2 pl-8 font-mono text-xs"
              />
            </div>
            <div className="flex items-center justify-between px-1 pt-1.5 text-[10px] text-muted-foreground">
              <span>
                {query.trim()
                  ? `${filtered.length} of ${total} match`
                  : `${total} coins on ${exchangeName}`}
              </span>
              {disabled && <span>Applying…</span>}
            </div>
          </div>

          <div role="listbox" aria-label={`${exchangeName} coins`} className="max-h-72 overflow-y-auto p-1">
            {error ? (
              <div className="px-3 py-3 text-xs text-danger">
                Could not load {exchangeName} coins: {error.message || "request failed"}
              </div>
            ) : isLoading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                Loading {exchangeName} coins…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">
                {total === 0
                  ? `No coins listed on ${exchangeName} right now.`
                  : `No ${exchangeName} coin matches “${query.trim()}”.`}
              </div>
            ) : (
              filtered.map((market) => {
                const sym = (market.symbol || "").toUpperCase()
                const selected = sym === active
                return (
                  <button
                    key={sym}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={disabled}
                    onMouseDown={(e) => {
                      // Commit before the outside-click handler can close us.
                      e.preventDefault()
                      handlePick(sym)
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left font-mono text-[13px] transition-colors disabled:opacity-50 ${
                      selected
                        ? "bg-primary/15 text-primary"
                        : "text-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {selected && <Check className="size-3.5" aria-hidden="true" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {(market.displayName || sym.replace("_", "/")).replace("_", "/")}
                      <span className="ml-1.5 text-[10px] text-muted-foreground">{sym}</span>
                    </span>
                    <span className="shrink-0 rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {market.maxLeverage ?? 20}x
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
