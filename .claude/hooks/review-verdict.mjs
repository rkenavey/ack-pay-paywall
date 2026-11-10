// Reads the JSON envelope printed by `claude -p --output-format json` for the
// Reviewer, takes the verdict object from its final message, writes it to
// <out> and prints a readable report.
// Exit 0 = pass, 3 = fail, 4 = no usable verdict (the gate fails closed).
import { readFileSync, writeFileSync } from "node:fs"

const [rawPath, outPath] = process.argv.slice(2)

function parse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function fromText(text) {
  if (typeof text !== "string") return undefined
  const direct = parse(text.trim())
  if (direct) return direct
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => parse(m[1])).filter(Boolean)
  if (fenced.length) return fenced.at(-1)
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  return start >= 0 && end > start ? parse(text.slice(start, end + 1)) : undefined
}

let raw = ""
try {
  raw = readFileSync(rawPath, "utf8")
} catch (error) {
  console.log(`cannot read reviewer output: ${error.message}`)
  process.exit(4)
}

const envelope = parse(raw)
const result = Array.isArray(envelope) ? envelope.findLast((m) => m?.type === "result") : envelope
const verdict = result?.structured_output ?? fromText(result?.result)

if (!verdict || (verdict.verdict !== "pass" && verdict.verdict !== "fail") || !Array.isArray(verdict.findings)) {
  const hint = result?.is_error ? `reviewer session errored: ${String(result.result ?? result.subtype).slice(0, 500)}` : "reviewer output had no verdict"
  console.log(hint)
  process.exit(4)
}

writeFileSync(outPath, JSON.stringify(verdict, null, 2) + "\n")

const lines = [`Reviewer verdict: ${verdict.verdict.toUpperCase()}`, verdict.summary ?? ""]
verdict.findings.forEach((f, i) => {
  const where = f.line ? `${f.file}:${f.line}` : f.file
  lines.push("", `${i + 1}. [rule ${f.rule}] ${where}`, `   problem: ${f.problem}`, `   fix:     ${f.fix}`)
})
if (verdict.notes?.length) {
  lines.push("", "Notes (not blocking):", ...verdict.notes.map((n) => `- ${n}`))
}
console.log(lines.join("\n"))

// A "pass" that still lists findings is contradictory; treat it as a fail.
process.exit(verdict.verdict === "pass" && verdict.findings.length === 0 ? 0 : 3)
