import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(__dirname, '..')
const distDir = path.resolve(frontendDir, 'dist')
const targetDir = path.resolve(frontendDir, '..', 'backend', 'frontend_dist')

console.log('Building frontend with vite...')
execSync('npm run build', { cwd: frontendDir, stdio: 'inherit' })

console.log(`Copying ${distDir} to ${targetDir}...`)
if (fs.existsSync(targetDir)) {
  fs.rmSync(targetDir, { recursive: true, force: true })
}
fs.cpSync(distDir, targetDir, { recursive: true })
console.log('Frontend built and copied to backend/frontend_dist successfully.')
