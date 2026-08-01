"use client"

import * as React from "react"

interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
  disabled?: boolean
}

export function Select({ value, onValueChange, children, disabled }: SelectProps) {
  return (
    <select 
      value={value} 
      onChange={(e) => onValueChange(e.target.value)}
      disabled={disabled}
      className="text-xs border rounded bg-background px-2 py-1"
    >
      {children}
    </select>
  )
}

export function SelectTrigger({ children, className }: { children: React.ReactNode; className?: string }) {
  return <>{children}</>
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  return <option value="">{placeholder}</option>
}

export function SelectContent({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export function SelectItem({ value, children }: { value: string; children: React.ReactNode }) {
  return <option value={value}>{children}</option>
}
