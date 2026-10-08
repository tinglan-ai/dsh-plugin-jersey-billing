/**
 * 构建 `lib/index.js`。
 *
 * 为什么需要构建：
 * `package.json` 的 `files` 只分发 `lib/`（安装到 profile 后没有 `src/` 目录），
 * 所以 `src/peak.js` 必须**内联**进 `lib/index.js`，否则安装副本会
 * `Cannot find module './peak.js'`。
 *
 * 做法：去掉 `peak.js` 里的 `export` 关键字，把它整段插到 `index.js` 的
 * import 之后。两个文件都是 ESM 且没有命名冲突，内联是安全的。
 *
 * 用法：
 *   node build.mjs
 *
 * 改完 `src/index.js` 或 `src/peak.js` 后必须跑一次，然后同步到安装副本：
 *   Copy-Item lib\index.js,lib\client.js <profile>\node_modules\dsh-plugin-jersey-billing\lib\
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const mainPath = join(root, 'src', 'index.js')
const peakPath = join(root, 'src', 'peak.js')
const outPath = join(root, 'lib', 'index.js')

let main = readFileSync(mainPath, 'utf8')
const peak = readFileSync(peakPath, 'utf8')

// 1. peak.js 的 export 去掉，变成普通声明。
const inlined = peak.replace(/^export function /gm, 'function ').replace(/^export const /gm, 'const ')

// 2. 去掉 index.js 里对 peak.js 的 import。
const importLine = /^import \{ isPeakTime, isCalendarCovered, PEAK_LABEL, OFF_PEAK_LABEL \} from '\.\/peak\.js'\n/m
if (!importLine.test(main)) {
  console.error('构建失败：src/index.js 里找不到 peak.js 的 import 行')
  process.exit(1)
}
main = main.replace(importLine, '')

// 3. 把内联副本插到最后一个 import 之后。
const anchor = "import { zstdDecompressSync } from 'node:zlib'\n"
if (!main.includes(anchor)) {
  console.error('构建失败：src/index.js 里找不到 node:zlib 的 import 行')
  process.exit(1)
}
const banner =
  '\n// ── 以下为 src/peak.js 的内联副本（安装包只分发 lib/，故必须内联）──\n' +
  '// 勿手工编辑这一段；改 src/peak.js 后重新跑 node build.mjs。\n'
main = main.replace(anchor, anchor + banner + inlined)

// 4. 自检：内联后不应再有对 peak.js 的引用，且关键导出都在。
const problems = []
if (main.includes("from './peak.js'")) problems.push('仍存在对 ./peak.js 的 import')
if (!main.includes('function isPeakTime')) problems.push('缺少 isPeakTime')
if (!main.includes('const HOLIDAYS')) problems.push('缺少 HOLIDAYS')
if (!main.includes('const MAKEUP_WORKDAYS')) problems.push('缺少 MAKEUP_WORKDAYS')
if (/\uFFFD/.test(main)) problems.push('含 U+FFFD 替换字符')
if (problems.length > 0) {
  console.error('构建失败：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

writeFileSync(outPath, main, 'utf8')
console.log(`已写入 ${outPath}`)
console.log(`  长度 ${main.length} 字节`)
console.log(`  行数 ${main.split('\n').length}`)
