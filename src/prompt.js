'use strict';

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { colors } = require('./util');

const c = colors(stdout);

/**
 * Run `fn` with a fresh readline interface, always closing it afterwards.
 * @template T
 * @param {(rl: import('node:readline/promises').Interface) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withPrompt(fn) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

/**
 * Ask a free-form question.
 * @param {import('node:readline/promises').Interface} rl
 * @param {string} message
 * @param {{default?:string, validate?:(value:string)=>(true|string), transform?:(value:string)=>any}} [opts]
 */
async function ask(rl, message, opts = {}) {
  const { default: def, validate, transform } = opts;
  const suffix = def !== undefined ? c.dim(` (${def})`) : '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = await rl.question(`${c.cyan('?')} ${message}${suffix}: `);
    const trimmed = raw.trim();
    const value = trimmed === '' ? def : trimmed;
    if (value === undefined || value === '') {
      stdout.write(`${c.yellow('!')} Please enter a value.\n`);
      continue;
    }
    if (validate) {
      const result = validate(value);
      if (result !== true) {
        stdout.write(`${c.yellow('!')} ${result}\n`);
        continue;
      }
    }
    return transform ? transform(value) : value;
  }
}

/**
 * Yes/no question.
 * @param {import('node:readline/promises').Interface} rl
 * @param {string} message
 * @param {boolean} [def]
 * @returns {Promise<boolean>}
 */
async function confirm(rl, message, def = true) {
  const hint = def ? 'Y/n' : 'y/N';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = (await rl.question(`${c.cyan('?')} ${message} ${c.dim(`(${hint})`)}: `)).trim();
    if (raw === '') return def;
    if (/^y(es)?$/i.test(raw)) return true;
    if (/^n(o)?$/i.test(raw)) return false;
    stdout.write(`${c.yellow('!')} Please answer yes or no.\n`);
  }
}

/**
 * Numbered single-choice question.
 * @param {import('node:readline/promises').Interface} rl
 * @param {string} message
 * @param {Array<{label:string, value:string, hint?:string}>} choices
 * @param {number} [defaultIndex]
 * @returns {Promise<string>}
 */
async function select(rl, message, choices, defaultIndex = 0) {
  stdout.write(`${c.cyan('?')} ${message}\n`);
  choices.forEach((choice, i) => {
    const marker = i === defaultIndex ? c.green('›') : ' ';
    const hint = choice.hint ? c.dim(` — ${choice.hint}`) : '';
    stdout.write(`  ${marker} ${i + 1}) ${choice.label}${hint}\n`);
  });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = (
      await rl.question(`  ${c.dim(`choose 1-${choices.length}`)} ${c.dim(`[${defaultIndex + 1}]`)}: `)
    ).trim();
    if (raw === '') return choices[defaultIndex].value;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
    stdout.write(`${c.yellow('!')} Enter a number between 1 and ${choices.length}.\n`);
  }
}

module.exports = { withPrompt, ask, confirm, select, colors: c };
