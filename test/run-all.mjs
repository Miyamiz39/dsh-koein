#!/usr/bin/env node
/** Run every test file in this directory, in order, as separate processes. */
import { readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort()

let failed = 0
for (const file of files) {
  console.log(`\n=== ${file} ===`)
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(here, file)], { cwd: path.dirname(here) })
    process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
  } catch (error) {
    failed += 1
    process.stdout.write(error.stdout || '')
    process.stderr.write(error.stderr || String(error))
  }
}
console.log(failed === 0 ? `\nall ${files.length} test file(s) passed` : `\n${failed} test file(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
