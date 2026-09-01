#!/usr/bin/env node

const { spawn } = require('node:child_process')

const env = { ...process.env }

;(async() => {
  // Run database migrations first
  console.log('Running database migrations...')
  try {
    await exec('npx drizzle-kit migrate')
    console.log('Migrations completed successfully')
  } catch (error) {
    console.error('Migration failed:', error.message)
    // Don't exit - let the app try to start anyway
  }

  // If running the web server then prerender pages
  if (process.argv.slice(-3).join(' ') === 'pnpm run start') {
    await exec('npx next build --experimental-build-mode generate')
  }

  // launch application
  await exec(process.argv.slice(2).join(' '))
})()

function exec(command) {
  const child = spawn(command, { shell: true, stdio: 'inherit', env })
  return new Promise((resolve, reject) => {
    child.on('exit', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} failed rc=${code}`))
      }
    })
  })
}
