import { spawnSync } from 'node:child_process'
import process from 'node:process'

const steps = [
  { name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
  { name: 'test', cmd: 'npm', args: ['test'] },
  { name: 'build', cmd: 'npm', args: ['run', 'build'] },
]

for (const step of steps) {
  console.log(`\n=== Running: ${step.name} ===`)
  const result = spawnSync(step.cmd, step.args, {
    stdio: 'inherit',
    shell: true,
  })
  if (result.status !== 0) {
    console.error(`\nVerification failed at step: ${step.name} (exit code ${result.status})`)
    process.exit(result.status || 1)
  }
}

console.log('\nAll verification steps passed successfully!')
process.exit(0)
