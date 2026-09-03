// fork-local: 把 @vercel/og 从 Worker 包体里摘掉，让部署能过 Cloudflare 免费档的 3 MiB。
//
// 背景：全站没有任何 next/og / ImageResponse 用法（grep app/ lib/ components/ 为 0）。
// 但 next/server 会静态再导出 ./dist/server/og/image-response，那里写的是
//   import(process.env.NEXT_RUNTIME === 'edge' ? '.../index.edge.js' : '.../index.node.js')
// 三元字面量的动态导入，esbuild 判不出分支，于是 edge/node 两条路径连同
// resvg.wasm(1.35M) + index.edge.js(0.79M) + yoga.wasm(70K) + Geist 字体一起进了产物。
// 这三件套单独就占 708 KiB gzip——正好是把博客顶死在 3 MiB 线上的那口气。
//
// 实测（wrangler deploy --dry-run，gzip）：
//   未裁剪 3297.02 KiB  ->  裁剪后 2560.48 KiB / 上限 3072 KiB
//
// 做法：不删依赖、只把 og 的实现换成明确报错的桩，并把二进制挪到 .trimmed/ 里备查。
// 在 build 前后各跑一次（build 前的改动可能不被 OpenNext 复制过去，实测需要覆盖产物目录）。
// 以后谁真要用 OG 图，会拿到一条写清楚原因的报错；恢复办法：npm ci 重装 next。
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const MARKER = 'fork-local trim'

// 保留同名导出，别让 next/server 的再导出炸成 undefined
const stubBody = (spec) => `"use strict";
// ${MARKER} (see scripts/trim-worker-bundle.mjs): @vercel/og is dead code in this app and
// is trimmed so the Worker fits Cloudflare's 3 MiB free-plan limit. Reinstall next to undo.
throw new Error('ImageResponse (@vercel/og) is unavailable in this build: trimmed to fit the\\n' +
  '  Cloudflare Workers free-plan size limit. See ${spec}.');
`

const ESM_STUB = `// ${MARKER} (see scripts/trim-worker-bundle.mjs): @vercel/og trimmed for the Workers size limit.
throw new Error('ImageResponse (@vercel/og) is unavailable in this build: trimmed to fit the Cloudflare Workers free-plan size limit. See scripts/trim-worker-bundle.mjs.');
`

const BINARIES = ['resvg.wasm', 'yoga.wasm', 'Geist-Regular.ttf', 'Geist-Medium.ttf']

const targets = [
  'node_modules/next/dist/compiled/@vercel/og',
  '.open-next/server-functions/default/node_modules/next/dist/compiled/@vercel/og',
  '.open-next/middleware/node_modules/next/dist/compiled/@vercel/og',
]

let touched = 0
for (const rel of targets) {
  const dir = resolve(root, rel)
  if (!existsSync(dir)) continue

  for (const file of ['index.edge.js', 'index.node.js']) {
    const p = join(dir, file)
    if (!existsSync(p)) continue
    writeFileSync(p, file.endsWith('edge.js') && rel.startsWith('node_modules') ? ESM_STUB : stubBody('scripts/trim-worker-bundle.mjs'))
  }

  const stash = join(dir, '.trimmed')
  for (const bin of BINARIES) {
    const p = join(dir, bin)
    if (!existsSync(p)) continue
    if (!existsSync(stash)) mkdirSync(stash, { recursive: true })
    renameSync(p, join(stash, bin))
  }
  // 桩里的 wasm 若被别处引用会解析失败，直接把 satori 目录也挪走（同样可恢复）
  const satori = join(dir, 'satori')
  if (existsSync(satori)) {
    if (!existsSync(stash)) mkdirSync(stash, { recursive: true })
    renameSync(satori, join(stash, 'satori'))
  }
  // 清掉 sourcemap，别让它白占体积
  for (const map of ['index.edge.js.map', 'index.node.js.map']) rmSync(join(dir, map), { force: true })

  touched += 1
  console.log(`trim-worker-bundle: ${relative(root, dir)} 已裁剪（二进制挪入 .trimmed/）`)
}

if (touched === 0) console.log('trim-worker-bundle: 未找到 @vercel/og 目录，跳过')
else console.log(`trim-worker-bundle: 共处理 ${touched} 处`)
