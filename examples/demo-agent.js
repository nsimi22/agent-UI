#!/usr/bin/env node
// A pretend agent so Agent Arcade has something to play with out of the box.
// Usage: node examples/demo-agent.js --persona scout "your task here"

const args = process.argv.slice(2);
const personaIdx = args.indexOf('--persona');
const persona = personaIdx >= 0 ? args.splice(personaIdx, 2)[1] : 'scout';
const task = args.join(' ') || 'something mysterious';

const PERSONAS = {
  scout: {
    failRate: 0,
    steps: [
      '🔭 Surveying the landscape for "{task}"…',
      '📚 Reading 3 docs, skimming 7 more.',
      '🧭 Found a promising trail.',
      '📝 Taking notes in very small handwriting.',
      '✨ Summary: {task} is totally doable. Here are the key points:\n  • start small\n  • measure twice\n  • ship once',
    ],
  },
  builder: {
    failRate: 0.1,
    steps: [
      '🧱 Laying foundations for "{task}".',
      '$ mkdir -p src && touch src/index.js',
      '🔨 hammering… hammering… hammering…',
      '🧪 Running tests: 12 passed, 0 failed',
      '📦 Built! Output is shiny and ready.',
    ],
  },
  gremlin: {
    failRate: 0.45,
    steps: [
      '😈 Oh, "{task}"? Sure, sure.',
      '🔧 Rewiring something that probably shouldn\'t be rewired.',
      '🍝 Achieved a beautiful plate of spaghetti code.',
      '🤞 Crossing all claws…',
      '🎲 It worked?! Nobody touch anything.',
    ],
  },
};

const p = PERSONAS[persona] || PERSONAS.scout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < p.steps.length; i++) {
    await sleep(600 + Math.random() * 1400);
    if (i === p.steps.length - 1 && Math.random() < p.failRate) {
      console.error('💥 Something exploded. Smells like burnt toast.');
      process.exit(1);
    }
    console.log(p.steps[i].split('{task}').join(task));
  }
})();
