"use client"

import React from "react"

interface Button3DProps {
  children: React.ReactNode
  active?: boolean
  onClick?: () => void
  disabled?: boolean
  className?: string
  size?: "sm" | "md"
  color?: "default" | "danger" | "success" | "warning"
}

const colorMap = {
  default: {
    active: "linear-gradient(180deg, #3b82f6 0%, #2563eb 100%)", activeBorder: "#1d4ed8", activeShadow: "0 3px 6px rgba(37,99,235,0.4), inset 0 1px 1px rgba(255,255,255,0.2)",
    inactive: "linear-gradient(180deg, #374151 0%, #1f2937 100%)", inactiveBorder: "#4b5563", inactiveShadow: "0 2px 4px rgba(0,0,0,0.3), inset 0 1px 1px rgba(255,255,255,0.05)",
  },
  danger: {
    active: "linear-gradient(180deg, #ef4444 0%, #dc2626 100%)", activeBorder: "#b91c1c", activeShadow: "0 3px 6px rgba(220,38,38,0.4), inset 0 1px 1px rgba(255,255,255,0.2)",
    inactive: "linear-gradient(180deg, #374151 0%, #1f2937 100%)", inactiveBorder: "#4b5563", inactiveShadow: "0 2px 4px rgba(0,0,0,0.3), inset 0 1px 1px rgba(255,255,255,0.05)",
  },
  success: {
    active: "linear-gradient(180deg, #10b981 0%, #059669 100%)", activeBorder: "#047857", activeShadow: "0 3px 6px rgba(5,150,105,0.4), inset 0 1px 1px rgba(255,255,255,0.2)",
    inactive: "linear-gradient(180deg, #374151 0%, #1f2937 100%)", inactiveBorder: "#4b5563", inactiveShadow: "0 2px 4px rgba(0,0,0,0.3), inset 0 1px 1px rgba(255,255,255,0.05)",
  },
  warning: {
    active: "linear-gradient(180deg, #f59e0b 0%, #d97706 100%)", activeBorder: "#b45309", activeShadow: "0 3px 6px rgba(217,119,6,0.4), inset 0 1px 1px rgba(255,255,255,0.2)",
    inactive: "linear-gradient(180deg, #374151 0%, #1f2937 100%)", inactiveBorder: "#4b5563", inactiveShadow: "0 2px 4px rgba(0,0,0,0.3), inset 0 1px 1px rgba(255,255,255,0.05)",
  },
}

export default function Button3D({ children, active = false, onClick, disabled = false, className = "", size = "sm", color = "default" }: Button3DProps) {
  const c = colorMap[color]
  const isActive = active && !disabled
  return (
    <button
      type="button" disabled={disabled} onClick={onClick}
      className={`relative rounded-lg font-medium select-none outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-all duration-150 ${className}`}
      style={{
        padding: size === "sm" ? "6px 12px" : "10px 18px", fontSize: size === "sm" ? 12 : 14,
        color: isActive ? "#fff" : "#9ca3af", background: isActive ? c.active : c.inactive,
        border: `1px solid ${isActive ? c.activeBorder : c.inactiveBorder}`,
        boxShadow: isActive ? c.activeShadow : c.inactiveShadow,
        opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer",
        transform: "translateY(0)", textShadow: isActive ? "0 1px 2px rgba(0,0,0,0.3)" : "none",
      }}
      onMouseDown={(e) => {
        if (!disabled) {
          const el = e.currentTarget
          el.style.transform = "translateY(2px)"
          el.style.boxShadow = isActive ? "inset 0 2px 4px rgba(0,0,0,0.4), 0 1px 1px rgba(0,0,0,0.1)" : "inset 0 3px 6px rgba(0,0,0,0.5), 0 0 0 rgba(0,0,0,0)"
        }
      }}
      onMouseUp={(e) => {
        const el = e.currentTarget
        el.style.transform = "translateY(0)"
        el.style.boxShadow = isActive ? c.activeShadow : c.inactiveShadow
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget
        el.style.transform = "translateY(0)"
        el.style.boxShadow = isActive ? c.activeShadow : c.inactiveShadow
      }}
    >
      {children}
    </button>
  )
}
