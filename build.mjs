/**
 * 构建 `lib/index.js`。
 *
 * `package.json` 的 `files` 只分发 `lib/`（安装到 profile 后没有 `src/` 目录），
 * 所以 `lib/index.js` 是 `src/index.js` 的**完整副本**。
 *
 * 早期版本还需要把 `src/peak.js` 内联进来；分峰谷计价随泽西一起下线后，
 * 源码只剩一个文件，构建退化成「复制 + 自检」。
 *
 * 用法：
 *   node build.mjs
 *
 * 改完 `src/index.js` 后必须跑一次，然后同步到安装副本：
 *   Copy-Item lib\index.js <profile>\node_modules\dsh-plugin-jersey-billing\lib\
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const srcPath = join(root, 'src', 'index.js')
const outPath = join(root, 'lib', 'index.js')

const main = readFileSync(srcPath, 'utf8')

// 自检：关键导出与常量必须在，且不能混入替换字符。
const problems = []
if (!main.includes("export const name = 'znb-billing'")) problems.push('缺少 name 导出')
if (!main.includes("export const inject = ['webServer']")) problems.push('缺少 inject 导出')
if (!main.includes("const ZNB_PROVIDER = 'znb-gongsi'")) problems.push('缺少 ZNB_PROVIDER')
if (!main.includes("const ROUTE_PATH = '/znb-billing'")) problems.push('缺少 ROUTE_PATH')
if (main.includes("from './peak.js'")) problems.push('仍存在对 ./peak.js 的 import')
if (main.includes('isPeakTime')) problems.push('仍残留 isPeakTime')
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
