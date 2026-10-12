import {createServerAdapter} from '../src/server/index.js';
console.log('Adapter shape:',Object.keys(createServerAdapter()).join(', '));
console.log('This is a structural smoke test only; to test Google authentication use agy interactively first.');
