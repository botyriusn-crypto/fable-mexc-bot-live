import { readFileSync, writeFileSync } from "fs"

function removeLines(file, start, end) {
  const lines = readFileSync(file, "utf8").split("\n")
  const removed = lines.slice(start - 1, end)
  const newLines = lines.slice(0, start - 1).concat(lines.slice(end))
  writeFileSync(file, newLines.join("\n"))
  console.log(`ok ${file}: removed lines ${start}-${end} (${removed.length} lines)`)
  console.log(`  first: ${removed[0]}`)
  console.log(`  last : ${removed[removed.length - 1]}`)
}

// bybit: second copy of tickSizeCache/getTickSize/roundPrice (lines 120-140)
removeLines("lib/bybit/private.ts", 120, 140)

// gateio: second copy of GateSpec/getGateSpec/roundGateQty/roundGatePrice (lines 117-161)
removeLines("lib/gateio/private.ts", 117, 161)
