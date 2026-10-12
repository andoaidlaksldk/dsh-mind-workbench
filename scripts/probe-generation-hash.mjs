#!/usr/bin/env node
/**
 * 一次性探针：推断 DSH Desktop「generation 目录名」里的 12 位内容哈希算法。
 * 目录名形如 `<name>+<version>+<12位十六进制>`，要写出合法的一代就必须能复算它。
 *
 * 用法：node scripts/probe-generation-hash.mjs <某个 live generation 目录>
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('用法：node scripts/probe-generation-hash.mjs <generation 目录>')
  process.exit(1)
}

const expected = basename(target).split('+').pop()
const prefix = basename(target).split('+').slice(0, -1).join('+')

function walk(directory, prefixPath = '') {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    const relative = prefixPath ? `${prefixPath}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...walk(absolute, relative))
    else files.push({ relative, absolute, size: statSync(absolute).size, data: readFileSync(absolute) })
  }
  return files
}

const files = walk(target)
const sortedByPath = [...files].sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0))
const rawOrder = files

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const md5 = (value) => createHash('md5').update(value).digest('hex')
const sha1 = (value) => createHash('sha1').update(value).digest('hex')
const sha512 = (value) => createHash('sha512').update(value).digest('hex')

function concatContents(list) {
  return Buffer.concat(list.map((file) => file.data))
}

function concatPathAndContent(list) {
  return Buffer.concat(list.map((file) => Buffer.concat([Buffer.from(file.relative, 'utf8'), file.data])))
}

function concatPathSize(list) {
  return Buffer.from(list.map((file) => `${file.relative}:${file.size}`).join('\n'), 'utf8')
}

function concatPerFileDigest(list, digest) {
  return Buffer.from(list.map((file) => `${file.relative}:${digest(file.data)}`).join('\n'), 'utf8')
}

const candidates = {
  'sha256(rawOrder contents)': sha256(concatContents(rawOrder)),
  'sha256(sorted contents)': sha256(concatContents(sortedByPath)),
  'sha256(sorted path+content)': sha256(concatPathAndContent(sortedByPath)),
  'sha256(rawOrder path+content)': sha256(concatPathAndContent(rawOrder)),
  'sha256(sorted path:size)': sha256(concatPathSize(sortedByPath)),
  'sha256(rawOrder path:size)': sha256(concatPathSize(rawOrder)),
  'sha256(sorted path:sha256)': sha256(concatPerFileDigest(sortedByPath, sha256)),
  'sha256(rawOrder path:sha256)': sha256(concatPerFileDigest(rawOrder, sha256)),
  'sha256(sorted path:md5)': sha256(concatPerFileDigest(sortedByPath, md5)),
  'md5(sorted path+content)': md5(concatPathAndContent(sortedByPath)),
  'md5(rawOrder path+content)': md5(concatPathAndContent(rawOrder)),
  'md5(sorted contents)': md5(concatContents(sortedByPath)),
  'sha1(sorted path+content)': sha1(concatPathAndContent(sortedByPath)),
  'sha1(sorted contents)': sha1(concatContents(sortedByPath)),
  'sha512(sorted path+content)': sha512(concatPathAndContent(sortedByPath)).slice(0, 12),
  'sha256(package.json)': sha256(readFileSync(join(target, 'package.json'))),
  'sha256(sorted names only)': sha256(Buffer.from(sortedByPath.map((file) => file.relative).join('\n'), 'utf8'))
}

console.log(`目录：${basename(target)}`)
console.log(`前缀：${prefix}`)
console.log(`期望哈希：${expected}`)
console.log(`文件数：${files.length}\n`)

let matched = false
for (const [label, digest] of Object.entries(candidates)) {
  const hit = digest.slice(0, 12) === expected ? '  <== 命中' : ''
  if (hit) matched = true
  console.log(`${digest.slice(0, 12)}  ${label}${hit}`)
}
console.log(matched ? '\n结论：已找到算法（见命中项）' : '\n结论：以上方案均未命中，需要继续扩大候选')
