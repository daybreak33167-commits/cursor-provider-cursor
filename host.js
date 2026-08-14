import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SEARCH_FILES = [
  process.argv[1],
  process.env.npm_execpath,
  join('D:', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  join('D:', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
].filter(Boolean)

function walkParents(start) {
  const dirs = []
  let current = start
  for (let i = 0; i < 12; i += 1) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

function candidateFiles() {
  const files = new Set(SEARCH_FILES)
  for (const seed of [...SEARCH_FILES, process.cwd()]) {
    if (!seed) continue
    const start = existsSync(seed) && seed.endsWith('.json') ? dirname(seed) : seed
    for (const dir of walkParents(start)) {
      files.add(join(dir, 'package.json'))
      files.add(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      files.add(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    }
  }
  return [...files]
}

function requireFrom(filename) {
  return createRequire(filename.endsWith('.json') || filename.endsWith('.js') || filename.endsWith('.mjs')
    ? filename
    : join(filename, 'package.json'))
}

export function resolveHost(id) {
  const errors = []
  for (const file of candidateFiles()) {
    if (!existsSync(file) && !file.endsWith('package.json')) continue
    try {
      return requireFrom(file).resolve(id)
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : error}`)
    }
  }
  throw new Error(`dsh-subscriptions: cannot resolve host package "${id}"\n${errors.slice(0, 8).join('\n')}`)
}

export async function importHost(id) {
  return import(pathToFileURL(resolveHost(id)).href)
}
