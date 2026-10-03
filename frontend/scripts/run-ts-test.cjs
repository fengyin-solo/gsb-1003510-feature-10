// 用仓库自带的 typescript 包现场转译 .ts，并处理 @/ 别名，避免依赖平台相关的 esbuild 二进制。
// 用法：node scripts/run-ts-test.cjs tests/warning-flow.test.ts
const path = require('path')
const fs = require('fs')
const Module = require('module')

const ROOT = path.resolve(__dirname, '..')
const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
const SRC = path.join(ROOT, 'src')

require.extensions['.ts'] = function (mod, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  })
  mod._compile(outputText, filename)
}

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request.startsWith('@/')) {
    request = path.join(SRC, request.slice(2)) + '.ts'
  }
  return origResolve.call(this, request, ...args)
}

const target = process.argv[2]
if (!target) {
  console.error('用法：node scripts/run-ts-test.cjs <测试文件>')
  process.exit(1)
}
require(path.resolve(ROOT, target))
