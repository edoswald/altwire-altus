const ORPHANS = [
  'hal:altwire:top_articles_7d',
  'hal:altwire:top_articles_30d',
];

async function main() {
  console.error('This legacy direct-delete script is disabled. Shared AltWire Hal memory is retained and must be reviewed through the governed retention process.');
  console.error(`Requested keys: ${ORPHANS.join(', ')}`);
  process.exitCode = 1;
}

main().catch(console.error);
