import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const FORBIDDEN_ANYWHERE = [
  'Start your local server',
  'ConnectGate',
]

const ALLOWED_LISTENING = [
  path.normalize('src/components/ServerConnectSteps.tsx'),
]

const ALLOWED_CONNECT_PY = [
  path.normalize('src/components/ConnectPanel.tsx'),
  path.normalize('src/lib/os.ts'),
]

export function checkFile(filePath, rootDir = ROOT) {
  const relPath = path.normalize(path.relative(rootDir, filePath))
  const isDist = relPath.startsWith('dist') || relPath.startsWith(path.normalize('dist/'))
  const content = fs.readFileSync(filePath, 'utf8')
  const errors = []

  // Check FORBIDDEN_ANYWHERE
  for (const term of FORBIDDEN_ANYWHERE) {
    if (content.toLowerCase().includes(term.toLowerCase())) {
      errors.push(`Found forbidden string "${term}" in ${relPath}`)
    }
  }

  // Check 'Listening for server'
  if (content.includes('Listening for server')) {
    if (!isDist) {
      const isAllowed = ALLOWED_LISTENING.some((allowed) => relPath.endsWith(allowed))
      if (!isAllowed) {
        errors.push(`Found "Listening for server" outside allowed file in ${relPath}`)
      }
    }
  }

  // Check 'connect.py'
  if (content.includes('connect.py')) {
    if (!isDist) {
      const isAllowed = ALLOWED_CONNECT_PY.some((allowed) => relPath.endsWith(allowed))
      if (!isAllowed) {
        errors.push(`Found "connect.py" outside allowed files in ${relPath}`)
      }
    }
  }

  return errors
}

export function scanDir(targetDir, rootDir = ROOT) {
  let allErrors = []
  if (!fs.existsSync(targetDir)) return allErrors

  const stat = fs.statSync(targetDir)
  if (stat.isFile()) {
    return checkFile(targetDir, rootDir)
  }

  const entries = fs.readdirSync(targetDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const fullPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      allErrors = allErrors.concat(scanDir(fullPath, rootDir))
    } else if (entry.isFile()) {
      if (/\.(tsx?|jsx?|mjs|cjs|html|css|json|txt|md)$/i.test(entry.name)) {
        allErrors = allErrors.concat(checkFile(fullPath, rootDir))
      }
    }
  }
  return allErrors
}

export function main() {
  const customTarget = process.argv[2]
  const targetDirs = customTarget
    ? [path.resolve(process.cwd(), customTarget)]
    : [
        path.join(ROOT, 'src'),
        ...(fs.existsSync(path.join(ROOT, 'dist')) ? [path.join(ROOT, 'dist')] : []),
      ]

  let errors = []
  for (const dir of targetDirs) {
    errors = errors.concat(scanDir(dir, ROOT))
  }

  if (errors.length > 0) {
    console.error('Forbidden strings check FAILED:')
    for (const err of errors) {
      console.error('  - ' + err)
    }
    process.exit(1)
  }

  console.log('check-forbidden: all checks passed.')
  process.exit(0)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
