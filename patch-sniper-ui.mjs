import { readFileSync, writeFileSync } from "fs"

const f = "components/bot/settings-panel.tsx"
let s = readFileSync(f, "utf8")

// 1. Re-add SNIPER_FIELDS array after SIZE_FIELDS
const sizeAnchor = `const SIZE_FIELDS: FieldDef[] = [{ key: "positionSizeUsdt", label: "Position size (USDT)" }]`
const sniperFields = `const SIZE_FIELDS: FieldDef[] = [{ key: "positionSizeUsdt", label: "Position size (USDT)" }]
const SNIPER_FIELDS: FieldDef[] = [
  { key: "sniperMaxEntries", label: "Sniper max entries", step: "1" },
  { key: "sniperPositionSizeUsdt", label: "Sniper position size (USDT)" },
  { key: "sniperLeverage", label: "Sniper leverage", step: "1" },
  { key: "sniperConfidenceFloor", label: "Sniper min confidence", step: "0.05" },
  { key: "sniperCorrThreshold", label: "Sniper correlation threshold", step: "0.05" },
  { key: "sniperSigmaExtreme", label: "Sniper sigma extreme", step: "0.1" },
  { key: "sniperVolumeSurgeMult", label: "Sniper volume surge ×", step: "0.1" },
  { key: "sniperMinVolumeUsdt", label: "Sniper min volume (USDT)" },
  { key: "sniperTargetRiskUsdt", label: "Sniper target risk (USDT)", step: "0.5" },
  { key: "sniperMinStopPct", label: "Sniper min stop distance (%)", step: "0.1", multiplier: 100 },
  { key: "sniperTpSlRatio", label: "Sniper TP:SL ratio (R)", step: "0.5" },
]`

if (s.includes(sizeAnchor)) {
  s = s.replace(sizeAnchor, sniperFields)
  console.log("ok  SNIPER_FIELDS array re-added")
} else {
  console.log("MISS SIZE_FIELDS anchor")
}

// 2. Re-add the "Sniper live" toggle + fields after renderFields(SIZE_FIELDS)
const renderAnchor = `{renderFields(SIZE_FIELDS)}`
const sniperToggle = `{renderFields(SIZE_FIELDS)}
        <Separator />
        <div className="flex items-center justify-between">
          <Label htmlFor="sniper-live" className="text-xs text-muted-foreground">
            Sniper live
          </Label>
          <Switch id="sniper-live" checked={Boolean(cfg.sniperLive)} onCheckedChange={(c) => toggleBool("sniperLive", c)} />
        </div>
        {renderFields(SNIPER_FIELDS)}`

if (s.includes(renderAnchor)) {
  s = s.replace(renderAnchor, sniperToggle)
  console.log("ok  Sniper live toggle + fields re-added")
} else {
  console.log("MISS renderFields(SIZE_FIELDS) anchor")
}

writeFileSync(f, s)
console.log("done")
