import { deleteAgentMemory } from '../lib/altus-db.js';

const ORPHANS = [
  'hal:altwire:top_articles_7d',
  'hal:altwire:top_articles_30d',
];

async function main() {
  for (const key of ORPHANS) {
    const result = await deleteAgentMemory('hal', key);
    console.log(`${result.deleted ? 'DELETED' : 'NOT FOUND'}: ${key}`);
  }
}

main().catch(console.error);