// `npm run dev`: same server, simulated cluster. (An inline VAR=x in an npm script breaks on Windows.)
process.env.CLUSTER ??= 'fake'
await import('./server.ts')
