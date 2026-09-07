"use client"

import React from "react"

interface Toggle3DProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  size?: "sm" | "md" | "lg"
  disabled?: boolean
}

const sizeMap = {
  sm: { w: 44, h: 24, thumb: 18, padding: 3, font: 11 },
  md: { w: 56, h: 30, thumb: 24, padding: 3, font: 13 },
  lg: { w: 72, h: 38, thumb: 32, padding: 3, font: 15 },
}

export default function Toggle3D({ checked, onChange, label, size = "md", disabled = false }: Toggle3DProps) {
  const s = sizeMap[size]
  const handleClick = () => { if (!disabled) onChange(!checked) }

  return (
    <div className="flex items-center justify-between gap-3">
      {label && <span className="text-xs text-muted-foreground select-none">{label}</span>}
      <button
        type="button" role="switch" aria-checked={checked} disabled={disabled}
        onClick={handleClick}
        className="relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-all duration-200 group"
        style={{
          width: s.w, height: s.h,
          background: checked ? "linear-gradient(180deg, #10b981 0%, #059669 100%)" : "linear-gradient(180deg, #374151 0%, #1f2937 100%)",
          boxShadow: checked ? "inset 0 1px 2px rgba(0,0,0,0.3), 0 2px 4px rgba(16,185,129,0.3), 0 0 12px rgba(16,185,129,0.15)" : "inset 0 2px 4px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.2)",
          border: checked ? "1px solid #059669" : "1px solid #4b5563",
          opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer", transform: "translateY(0)",
        }}
        onMouseDown={(e) => {
          if (!disabled) {
            const el = e.currentTarget
            el.style.transform = "translateY(1px)"
            el.style.boxShadow = checked ? "inset 0 2px 4px rgba(0,0,0,0.4), 0 1px 1px rgba(16,185,129,0.2)" : "inset 0 3px 6px rgba(0,0,0,0.5), 0 0 0 rgba(0,0,0,0)"
          }
        }}
        onMouseUp={(e) => {
          const el = e.currentTarget
          el.style.transform = "translateY(0)"
          el.style.boxShadow = checked ? "inset 0 1px 2px rgba(0,0,0,0.3), 0 2px 4px rgba(16,185,129,0.3), 0 0 12px rgba(16,185,129,0.15)" : "inset 0 2px 4px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.2)"
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget
          el.style.transform = "translateY(0)"
          el.style.boxShadow = checked ? "inset 0 1px 2px rgba(0,0,0,0.3), 0 2px 4px rgba(16,185,129,0.3), 0 0 12px rgba(16,185,129,0.15)" : "inset 0 2px 4px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.2)"
        }}
      >
        <span className="absolute font-bold select-none pointer-events-none transition-opacity duration-200" style={{ fontSize: s.font - 2, color: checked ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.4)", left: checked ? s.padding + 2 : s.w - s.thumb - s.padding + 2, top: "50%", transform: "translateY(-50%)", opacity: checked ? 1 : 0.6 }}>
          {checked ? "ON" : "OFF"}
        </span>
        <div className="absolute rounded-full transition-all duration-200 ease-out" style={{ width: s.thumb, height: s.thumb, top: s.padding, left: checked ? s.w - s.thumb - s.padding : s.padding, background: "linear-gradient(180deg, #f3f4f6 0%, #d1d5db 100%)", boxShadow: "0 2px 4px rgba(0,0,0,0.3), inset 0 1px 1px rgba(255,255,255,0.8), inset 0 -1px 1px rgba(0,0,0,0.1)", border: "1px solid #9ca3af" }} />
      </button>
    </div>
  )
}
